import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { HERO_IMAGE_ACCEPT, formatBytes, validateHeroImage } from './hero-image';

/**
 * The hero-image drop: one image, dragged in or picked, with its alt text.
 *
 * Shared by the two places an operator supplies one - the manual-topic drawer
 * (attach while briefing, uploaded when the draft is saved) and the pipeline
 * article panel (uploaded on the spot). The difference between them is entirely
 * in the parent: this component owns the preview, the client-side vetting and
 * the drag state, and nothing else.
 */
export function HeroImageField({
  url,
  file = null,
  alt,
  onPick,
  onRemove,
  onAltChange,
  busy = false,
  status = null,
  error = null,
  hint,
  label = 'Hero image',
}: {
  /** The image attached on the server, if any. */
  url: string | null;
  /** A file picked in the browser and not uploaded yet. */
  file?: File | null;
  alt: string;
  onPick: (file: File) => void;
  onRemove: () => void;
  onAltChange: (alt: string) => void;
  busy?: boolean;
  /** Progress line under the preview, e.g. "uploading…" or "✓ attached". */
  status?: string | null;
  /** Failure raised by the parent's own upload/remove call. */
  error?: string | null;
  hint: string;
  /** null when the surface already heads the field with its own title. */
  label?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const altId = useId();

  // A picked file previews straight from memory - no round trip, and no
  // dangling blob URL once it has been uploaded (or dropped).
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const accept = (picked: File | undefined) => {
    if (!picked) return;
    const problem = validateHeroImage(picked);
    setLocalError(problem);
    if (!problem) onPick(picked);
    if (inputRef.current) inputRef.current.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    accept(e.dataTransfer.files[0]); // a hero is singular - extras are ignored
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!busy) setDragging(true);
  };

  const src = previewUrl ?? url;
  const problem = localError ?? error;

  return (
    <div
      className="field hero-field"
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {label && (
        <label>
          {label} <span className="opt">OPTIONAL</span>
          {src && <span className="count">{file ? 'ready to upload' : 'attached'}</span>}
        </label>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={HERO_IMAGE_ACCEPT}
        hidden
        onChange={(e) => accept(e.target.files?.[0])}
      />

      {src ? (
        <div className="hero-card">
          <img className="hero-preview" src={src} alt={alt || 'Hero image preview'} />
          <div className="hero-actions">
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              Replace image
            </button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={onRemove}>
              Remove
            </button>
            <span className="hero-meta">
              {file ? `${file.name} · ${formatBytes(file.size)}` : status ?? 'stored'}
            </span>
          </div>
          <div className="hero-alt">
            <label htmlFor={altId}>Alt text</label>
            <input
              id={altId}
              className="input"
              placeholder="What the photo shows, e.g. “Ninja air fryer on a kitchen bench”"
              value={alt}
              disabled={busy}
              onChange={(e) => onAltChange(e.target.value)}
            />
            <p className="hint">
              Used as the image's alt attribute and in the article's social preview. Left empty, the
              site falls back to the post title.
            </p>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`dropzone${dragging ? ' dragging' : ''}${problem ? ' invalid' : ''}`}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <div className="dz-icon">🖼️</div>
          <div className="dz-main">
            <b>Drop an image</b> or click to choose one
          </div>
          <div className="dz-sub">JPEG, PNG or WebP · up to 10 MB · 16:9 crops best</div>
        </button>
      )}

      {problem && <div className="field-error">{problem}</div>}
      {!problem && !src && status && <div className="hint">{status}</div>}
      <p className="hint">{hint}</p>
    </div>
  );
}
