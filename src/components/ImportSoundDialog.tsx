import { useRef, useState } from 'react';

export interface ImportSoundData {
  file: File;

  name: string;
  description: string;

  categoryPaths: string[][];
  tags: string[];

  durationMs?: number;
  originalFileName: string;
  fileType: string;
  mimeType: string;
  fileSizeBytes: number;

  attribution?: string;
  license?: string;
  sourceUrl?: string;
}

interface ImportSoundDialogProps {
  onCancel: () => void;
  onImport: (data: ImportSoundData) => void;
  isImporting: boolean;
}

function makeDisplayName(fileName: string): string {
  const withoutExtension =
    fileName.replace(/\.[^/.]+$/, '');

  return withoutExtension
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) =>
      letter.toUpperCase()
    );
}

function getFileType(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');

  if (lastDot < 0) {
    return '';
  }

  return fileName
    .substring(lastDot + 1)
    .toLowerCase();
}

async function getAudioDuration(
  file: File
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const objectUrl = URL.createObjectURL(file);

    audio.preload = 'metadata';

    audio.onloadedmetadata = () => {
      const durationMs =
        Number.isFinite(audio.duration)
          ? Math.round(audio.duration * 1000)
          : undefined;

      URL.revokeObjectURL(objectUrl);

      resolve(durationMs);
    };

    audio.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(undefined);
    };

    audio.src = objectUrl;
  });
}

function ImportSoundDialog({
  onCancel,
  onImport,
  isImporting,
}: ImportSoundDialogProps) {
  const fileInputRef =
    useRef<HTMLInputElement>(null);
  
  const [file, setFile] =
    useState<File | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] =
    useState('');

  const [categoryPathText, setCategoryPathText] =
    useState('');

  const [tagsText, setTagsText] =
    useState('');

  const [durationMs, setDurationMs] =
    useState<number | undefined>();

  const [attribution, setAttribution] =
    useState('');

  const [license, setLicense] =
    useState('');

  const [sourceUrl, setSourceUrl] =
    useState('');

  async function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const selectedFile =
      event.target.files?.[0];

    if (!selectedFile) {
      return;
    }

    setFile(selectedFile);

    setName(
      makeDisplayName(selectedFile.name)
    );

    const detectedDuration =
      await getAudioDuration(selectedFile);

    setDurationMs(detectedDuration);
  }

  function handleImport() {
    if (!file) {
      return;
    }

    const trimmedName = name.trim();

    if (!trimmedName) {
      return;
    }

    const categoryPaths =
        categoryPathText
            .split('\n')
            .map((path) =>
                path
                    .split('>')
                    .map((part) => part.trim())
                    .filter(Boolean)
                    .slice(0, 2)
            )
            .filter((path) => path.length > 0);

    const tags =
      tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

    onImport({
      file,

      name: trimmedName,
      description: description.trim(),

      categoryPaths,
      tags,

      durationMs,

      originalFileName: file.name,
      fileType: getFileType(file.name),
      mimeType:
        file.type || 'application/octet-stream',
      fileSizeBytes: file.size,

      attribution:
        attribution.trim() || undefined,

      license:
        license.trim() || undefined,

      sourceUrl:
        sourceUrl.trim() || undefined,
    });
  }

  return (
    <div className="dialog-backdrop">
      <div className="import-sound-dialog">
        <h2>Import Sound</h2>

        <div className="import-row">
            <label>File</label>

            <button
                type="button"
                className="import-file-button"
                onClick={() =>
                fileInputRef.current?.click()
                }
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

        {file && (
          <div className="import-file-info">
            <span>
              {getFileType(file.name).toUpperCase()}
            </span>

            <span>
              {(file.size / 1024 / 1024).toFixed(2)} MB
            </span>

            {durationMs !== undefined && (
              <span>
                {(durationMs / 1000).toFixed(1)} sec
              </span>
            )}
          </div>
        )}

        <div className="import-row">
          <label>Name</label>

          <input
            type="text"
            value={name}
            onChange={(event) =>
              setName(event.target.value)
            }
          />
        </div>

        <div className="import-row">
          <label>Tags</label>

          <input
            type="text"
            placeholder="wolf, howl, creature"
            value={tagsText}
            onChange={(event) =>
              setTagsText(event.target.value)
            }
          />
        </div>

        <div className="import-row vertical">
          <label>Categories</label>

          <textarea
            placeholder={
              'Creatures > Animals > Wolves\nFantasy > Forest'
            }
            value={categoryPathText}
            onChange={(event) =>
              setCategoryPathText(
                event.target.value
              )
            }
          />
        </div>

        <div className="import-row vertical">
          <label>Description</label>

          <textarea
            value={description}
            onChange={(event) =>
              setDescription(
                event.target.value
              )
            }
          />
        </div>

        <details className="import-optional">
          <summary>
            Attribution / Licensing
          </summary>

          <div className="import-row">
            <label>Credit</label>

            <input
              type="text"
              value={attribution}
              onChange={(event) =>
                setAttribution(
                  event.target.value
                )
              }
            />
          </div>

          <div className="import-row">
            <label>License</label>

            <input
              type="text"
              value={license}
              onChange={(event) =>
                setLicense(
                  event.target.value
                )
              }
            />
          </div>

          <div className="import-row">
            <label>Source</label>

            <input
              type="text"
              value={sourceUrl}
              onChange={(event) =>
                setSourceUrl(
                  event.target.value
                )
              }
            />
          </div>
        </details>

        <div className="dialog-buttons">
          <button 
            onClick={onCancel}
            disabled={isImporting}
            >
            Cancel
          </button>

          <button
            disabled={
                !file ||
                !name.trim() ||
                isImporting
            }
            onClick={handleImport}
            >
                {isImporting ? 'Importing...' : 'Import'}
            </button>
        </div>
      </div>
    </div>
  );
}

export default ImportSoundDialog;