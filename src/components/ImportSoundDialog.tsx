import { useEffect, useRef, useState } from 'react';

export type ImportSoundSourceType = 'local' | 'url';

export interface ImportSoundData {
  sourceType: ImportSoundSourceType;
  file?: File;
  webUrl?: string;
  name: string;
  description: string;
  categoryPaths: string[][];
  tags: string[];
  durationMs?: number;
  originalFileName?: string;
  fileType?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  attribution?: string;
  license?: string;
  sourceUrl?: string;
}

interface ImportSoundDialogProps {
  onCancel: () => void;
  onImport: (
    data: ImportSoundData
  ) => void;
  isImporting: boolean;
}

function makeDisplayName(fileName: string): string {
  return fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getFileType(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot < 0 ? '' : fileName.substring(lastDot + 1).toLowerCase();
}

function getUrlFileName(url: string): string | undefined {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop();
  } catch {
    return undefined;
  }
}

function ImportSoundDialog({
  onCancel,
  onImport,
  isImporting,
}: ImportSoundDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const [sourceType, setSourceType] = useState<ImportSoundSourceType>('local');
  const [file, setFile] = useState<File | null>(null);
  const [webUrl, setWebUrl] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryPathText, setCategoryPathText] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [durationMs, setDurationMs] = useState<number | undefined>();
  const [attribution, setAttribution] = useState('');
  const [license, setLicense] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;

    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }

    setPreviewing(false);
  }

  useEffect(() => () => stopPreview(), []);

  async function inspectAudio(source: string): Promise<number | undefined> {
    return await new Promise((resolve) => {
      const audio = new Audio(source);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => resolve(
        Number.isFinite(audio.duration)
          ? Math.round(audio.duration * 1000)
          : undefined
      );
      audio.onerror = () => resolve(undefined);
    });
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];

    if (!selectedFile) {
      return;
    }

    stopPreview();
    setFile(selectedFile);
    setName(makeDisplayName(selectedFile.name));
    const objectUrl = URL.createObjectURL(selectedFile);
    const detectedDuration = await inspectAudio(objectUrl);
    URL.revokeObjectURL(objectUrl);
    setDurationMs(detectedDuration);
  }

  async function handlePreview() {
    stopPreview();
    setPreviewError(null);
    let previewSource: string;

    if (sourceType === 'local') {
      if (!file) {
        return;
      }

      previewSource = URL.createObjectURL(file);
      previewObjectUrlRef.current = previewSource;
    } else {
      previewSource = webUrl.trim();

      if (!previewSource) {
        setPreviewError('Enter a directly playable audio URL.');
        return;
      }
    }

    const audio = new Audio(previewSource);
    audioRef.current = audio;
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) {
        setDurationMs(Math.round(audio.duration * 1000));
      }
    };
    audio.onended = stopPreview;
    audio.onerror = () => {
      stopPreview();
      setPreviewError(
        'Unable to play this URL. It may be invalid, protected, or blocked by CORS.'
      );
    };

    try {
      await audio.play();
      setPreviewing(true);
    } catch {
      stopPreview();
      setPreviewError(
        'Playback failed. Check that the URL is a public, browser-playable media file.'
      );
    }
  }

  function handleImport() {
    const trimmedName = name.trim();

    if (
      !trimmedName ||
      (sourceType === 'local' && !file) ||
      (sourceType === 'url' && !webUrl.trim())
    ) {
      return;
    }

    const categoryPaths = categoryPathText
      .split('\n')
      .map((path) => path.split('>').map((part) => part.trim()).filter(Boolean))
      .filter((path) => path.length > 0);
    const tags = tagsText.split(',').map((tag) => tag.trim()).filter(Boolean);
    const urlFileName = sourceType === 'url'
      ? getUrlFileName(webUrl.trim())
      : undefined;

    stopPreview();
    onImport({
      sourceType,
      file: file ?? undefined,
      webUrl: sourceType === 'url' ? webUrl.trim() : undefined,
      name: trimmedName,
      description: description.trim(),
      categoryPaths,
      tags,
      durationMs,
      originalFileName: file?.name ?? urlFileName,
      fileType: getFileType(file?.name ?? urlFileName ?? ''),
      mimeType: file?.type || undefined,
      fileSizeBytes: file?.size,
      attribution: attribution.trim() || undefined,
      license: license.trim() || undefined,
      sourceUrl:
        sourceUrl.trim() ||
        (sourceType === 'url' ? webUrl.trim() : undefined),
    });
  }

  const previewAvailable = sourceType === 'local'
    ? file !== null
    : webUrl.trim().length > 0;
  const importDisabled =
  !name.trim() ||
  isImporting ||
  (
    sourceType === 'local' &&
    !file
  ) ||
  (
    sourceType === 'url' &&
    !webUrl.trim()
  );

  return (
    <div className="dialog-backdrop">
      <div className="import-sound-dialog">
        <h2>Import Sound</h2>

        <div className="import-source-tabs">
          <button
            className={sourceType === 'local' ? 'active' : ''}
            onClick={() => {
              stopPreview();
              setPreviewError(null);
              setSourceType('local');
            }}
          >
            Local File
          </button>
          <button
            className={sourceType === 'url' ? 'active' : ''}
            onClick={() => {
              stopPreview();
              setPreviewError(null);
              setSourceType('url');
            }}
          >
            Web URL
          </button>
        </div>
        {sourceType === 'local' ? (
          <>
            <div className="import-row">
              <label>File</label>
              <button
                type="button"
                className="import-file-button"
                onClick={() => fileInputRef.current?.click()}
              >
                {file ? file.name : 'Choose...'}
              </button>
              <input
                ref={fileInputRef}
                className="import-file-input"
                type="file"
                accept="audio/*"
                onChange={handleFileChange}
              />
            </div>
          </>
        ) : (
          <div className="import-row">
            <label>URL</label>
            <input
              type="url"
              placeholder="https://example.com/audio.mp3"
              value={webUrl}
              onChange={(event) => setWebUrl(event.target.value)}
            />
          </div>
        )}

        <div className="import-preview-controls">
          <button disabled={!previewAvailable || previewing} onClick={() => void handlePreview()}>
            Play
          </button>
          <button disabled={!previewing} onClick={stopPreview}>Stop</button>
          {previewError && <span className="import-error">{previewError}</span>}
        </div>

        {file && sourceType === 'local' && (
          <div className="import-file-info">
            <span>{getFileType(file.name).toUpperCase()}</span>
            <span>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
            {durationMs !== undefined && <span>{(durationMs / 1000).toFixed(1)} sec</span>}
          </div>
        )}

        <div className="import-row">
          <label>Name</label>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="import-row">
          <label>Tags</label>
          <input
            placeholder="wolf, howl, creature"
            value={tagsText}
            onChange={(event) => setTagsText(event.target.value)}
          />
        </div>
        <div className="import-row vertical">
          <label>Categories</label>
          <textarea
            placeholder={'Creatures > Animals\nFantasy > Forest'}
            value={categoryPathText}
            onChange={(event) => setCategoryPathText(event.target.value)}
          />
        </div>
        <div className="import-row vertical">
          <label>Description</label>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>

        <details className="import-optional">
          <summary>Attribution / Licensing</summary>
          <div className="import-row">
            <label>Credit</label>
            <input value={attribution} onChange={(event) => setAttribution(event.target.value)} />
          </div>
          <div className="import-row">
            <label>License</label>
            <input value={license} onChange={(event) => setLicense(event.target.value)} />
          </div>
          <div className="import-row">
            <label>Source</label>
            <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} />
          </div>
        </details>

        <div className="dialog-buttons">
          <button onClick={onCancel} disabled={isImporting}>Cancel</button>
          <button disabled={importDisabled} onClick={handleImport}>
            {isImporting ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ImportSoundDialog;
