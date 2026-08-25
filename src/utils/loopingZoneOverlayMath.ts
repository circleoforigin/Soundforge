import type { LoopingZoneSpawnBounds } from '../audio/LoopingZoneScheduler.ts';

const CENTER = 50;
const SCALE = 50;
const MIN_VISUAL_RADIAL_WIDTH = 0.006;
const MIN_VISUAL_ARC_DEGREES = 0.75;

function point(radius: number, angleDegrees: number): { x: number; y: number } {
  const radians = angleDegrees * Math.PI / 180;
  return { x: CENTER + Math.sin(radians) * radius * SCALE, y: CENTER - Math.cos(radians) * radius * SCALE };
}

function pair(value: { x: number; y: number }): string { return `${value.x} ${value.y}`; }

export function getLoopingZoneOverlayPath(bounds: LoopingZoneSpawnBounds): string {
  let innerRadius = bounds.innerRadius;
  let outerRadius = bounds.outerRadius;
  if (outerRadius - innerRadius < MIN_VISUAL_RADIAL_WIDTH) {
    const centerRadius = (innerRadius + outerRadius) / 2;
    innerRadius = Math.max(0, centerRadius - MIN_VISUAL_RADIAL_WIDTH / 2);
    outerRadius = Math.min(1, centerRadius + MIN_VISUAL_RADIAL_WIDTH / 2);
  }
  const arcWidth = Math.max(MIN_VISUAL_ARC_DEGREES, Math.min(360, bounds.arcWidthDegrees));
  const startAngle = bounds.centerAngleDegrees - arcWidth / 2;
  const endAngle = bounds.centerAngleDegrees + arcWidth / 2;
  const outerSvgRadius = outerRadius * SCALE;
  const innerSvgRadius = innerRadius * SCALE;

  if (arcWidth >= 359.999) {
    const outerTop = point(outerRadius, 0); const outerBottom = point(outerRadius, 180);
    if (innerRadius <= 1e-9) {
      return `M ${pair(outerTop)} A ${outerSvgRadius} ${outerSvgRadius} 0 1 1 ${pair(outerBottom)} A ${outerSvgRadius} ${outerSvgRadius} 0 1 1 ${pair(outerTop)} Z`;
    }
    const innerTop = point(innerRadius, 0); const innerBottom = point(innerRadius, 180);
    return `M ${pair(outerTop)} A ${outerSvgRadius} ${outerSvgRadius} 0 1 1 ${pair(outerBottom)} A ${outerSvgRadius} ${outerSvgRadius} 0 1 1 ${pair(outerTop)} M ${pair(innerTop)} A ${innerSvgRadius} ${innerSvgRadius} 0 1 0 ${pair(innerBottom)} A ${innerSvgRadius} ${innerSvgRadius} 0 1 0 ${pair(innerTop)} Z`;
  }

  const outerStart = point(outerRadius, startAngle); const outerEnd = point(outerRadius, endAngle);
  const largeArc = arcWidth > 180 ? 1 : 0;
  if (innerRadius <= 1e-9) {
    return `M ${pair(outerStart)} A ${outerSvgRadius} ${outerSvgRadius} 0 ${largeArc} 1 ${pair(outerEnd)} L ${CENTER} ${CENTER} Z`;
  }
  const innerEnd = point(innerRadius, endAngle); const innerStart = point(innerRadius, startAngle);
  return `M ${pair(outerStart)} A ${outerSvgRadius} ${outerSvgRadius} 0 ${largeArc} 1 ${pair(outerEnd)} L ${pair(innerEnd)} A ${innerSvgRadius} ${innerSvgRadius} 0 ${largeArc} 0 ${pair(innerStart)} Z`;
}
