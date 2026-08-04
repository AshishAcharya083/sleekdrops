import { useEffect, useMemo, useRef, useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type { ManualTopicPayload, ReferenceMaterial, Topic } from '../api';
import { api, TOPIC_CATEGORIES, TOPIC_POST_TYPES } from '../api';

const MAX_REFERENCES = 5;
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;

interface FileRef {
  name: string;
  content: string;
  size: number;
}

type Submitting = 'draft' | 'approve' | null;

/** The manual topic capture drawer: draft-first, with a separate confirmed
 *  "Approve & start now" path. Reused for both creating and editing a draft. */
export function ManualTopicDrawer({
  editing,
  onClose,
  onSaved,
}: {
  editing: Topic | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [category, setCategory] = useState<string>(TOPIC_CATEGORIES[0]);
  const [postType, setPostType] = useState<string>(TOPIC_POST_TYPES[0]);
  const [files, setFiles] = useState<FileRef[]>([]);
  const [pastes, setPastes] = useState<string[]>([]);
  const [showPaste, setShowPaste] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [titleTouched, setTitleTouched] = useState(false);
  const [submitting, setSubmitting] = useState<Submitting>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The saved draft id - set after a successful "Save as draft" (success state)
  // or captured when editing, so the success-state actions can approve it.
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedAsDraft, setSavedAsDraft] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setTitle(editing.title);
    setInstructions(editing.instructions ?? '');
    setCategory(editing.category);
    setPostType(editing.post_type);
    setFiles(
      (editing.research_notes ?? []).map((r) => ({
        name: r.name,
        content: r.content,
        size: new Blob([r.content]).size,
      })),
    );
    setSavedId(editing.id);
  }, [editing]);

  const nonEmptyPastes = useMemo(() => pastes.filter((p) => p.trim() !== ''), [pastes]);
  const referenceCount = files.length + nonEmptyPastes.length;
  const titleInvalid = titleTouched && title.trim() === '';
  const formValid = title.trim() !== '' && !fileError;
  const issues = (titleInvalid ? 1 : 0) + (fileError ? 1 : 0);

  const buildReferences = (): ReferenceMaterial[] => [
    ...files.map((f) => ({ name: f.name, content: f.content })),
    ...nonEmptyPastes.map((content, i) => ({ name: `reference-${i + 1}.md`, content })),
  ];

  const readFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setFileError(null);
    const incoming = [...fileList];
    const accepted: FileRef[] = [];
    for (const file of incoming) {
      if (!file.name.toLowerCase().endsWith('.md')) {
        setFileError(`${file.name}: only .md files are accepted`);
        continue;
      }
      if (file.size > MAX_REFERENCE_BYTES) {
        setFileError(`${file.name}: exceeds the 2 MB limit`);
        continue;
      }
      if (files.length + nonEmptyPastes.length + accepted.length >= MAX_REFERENCES) {
        setFileError(`At most ${MAX_REFERENCES} reference materials`);
        break;
      }
      const content = await file.text();
      accepted.push({ name: file.name, content, size: file.size });
    }
    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setFileError(null);
  };

  const addPaste = () => {
    if (referenceCount >= MAX_REFERENCES) {
      setFileError(`At most ${MAX_REFERENCES} reference materials`);
      return;
    }
    setShowPaste(true);
    setPastes((prev) => [...prev, '']);
  };

  const resetForm = () => {
    setTitle('');
    setInstructions('');
    setCategory(TOPIC_CATEGORIES[0]);
    setPostType(TOPIC_POST_TYPES[0]);
    setFiles([]);
    setPastes([]);
    setShowPaste(false);
    setFileError(null);
    setTitleTouched(false);
    setError(null);
    setSavedId(null);
    setSavedAsDraft(false);
  };

  /** Structural shape of the brief - counts and enums, never the prose itself. */
  const briefShape = () => ({
    mode: savedId ? 'edit' : 'create',
    category,
    post_type: postType,
    reference_count: referenceCount,
    instructions_provided: instructions.trim() !== '',
  });

  /** Create or update the draft; returns its id, or null on failure. */
  const saveDraft = async (): Promise<string | null> => {
    const payload: ManualTopicPayload = {
      ...(savedId ? { id: savedId } : {}),
      title: title.trim(),
      instructions: instructions.trim(),
      category,
      post_type: postType,
      references: buildReferences(),
    };
    const { topic } = await api<{ topic: Topic }>('/api/topics/manual', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setSavedId(topic.id);
    return topic.id;
  };

  const onSaveDraft = async () => {
    if (!formValid) {
      setTitleTouched(true);
      return;
    }
    setSubmitting('draft');
    setError(null);
    const shape = briefShape();
    try {
      await saveDraft();
      track(EVENTS.manualTopicSaved, { ...shape, action: 'draft' });
      setSavedAsDraft(true);
    } catch (e) {
      captureError(e, { action: 'manual_topic_draft', surface: 'manual-drawer' });
      setError((e as Error).message);
    } finally {
      setSubmitting(null);
    }
  };

  const approve = async (id: string) => {
    await api(`/api/topics/${id}/approve`, { method: 'POST' });
  };

  /** Confirmed "Approve & start now": save then fire the generation run. */
  const onConfirmApprove = async () => {
    setConfirmOpen(false);
    setSubmitting('approve');
    setError(null);
    const shape = briefShape();
    try {
      const id = savedAsDraft && savedId ? savedId : await saveDraft();
      if (!id) throw new Error('could not save the topic');
      track(EVENTS.manualTopicSaved, { ...shape, action: 'approve', topic_id: id });
      await approve(id);
      track(EVENTS.topicApproved, {
        count: 1,
        source: 'manual',
        surface: 'manual-drawer',
        topic_id: id,
      });
      onSaved(`Topic approved - “${title.trim()}” is now generating.`);
    } catch (e) {
      captureError(e, { action: 'manual_topic_approve', surface: 'manual-drawer' });
      setError((e as Error).message);
      setSubmitting(null);
    }
  };

  const busy = submitting !== null;

  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Manual topic">
        <div className="drawer-head">
          <div className="htext">
            <h2>
              {editing ? 'Edit draft topic' : 'New manual topic'}
              <span className="badge violet">✍️ Manual</span>
            </h2>
            <p>
              Hand off a specific topic to the article agents, with your own instructions and
              reference material. Saved as a draft first - nothing generates until you approve it.
            </p>
          </div>
          <button className="close-x" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>

        {savedAsDraft ? (
          <div className="drawer-body">
            <div className="success-wrap">
              <div className="success-icon">📋</div>
              <h3>Draft topic saved</h3>
              <p className="muted">
                “{title.trim()}” is waiting in Draft manual topics. Approve it to create the article
                and start research.
              </p>
              {error && <div className="field-error">{error}</div>}
              <div className="success-actions">
                <button
                  className="btn violet"
                  disabled={busy}
                  onClick={() => setConfirmOpen(true)}
                >
                  {submitting === 'approve' ? 'Approving…' : 'Approve & generate'}
                </button>
                <button className="btn secondary" disabled={busy} onClick={resetForm}>
                  Add another
                </button>
                <button className="btn ghost" disabled={busy} onClick={onClose}>
                  View in Topics
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="drawer-body">
              <div className="field">
                <label htmlFor="mt-title">
                  Topic / title <span className="req">REQUIRED</span>
                  <span className="count">{title.length}</span>
                </label>
                <input
                  id="mt-title"
                  className={`input${titleInvalid ? ' invalid' : ''}`}
                  placeholder="e.g. Best budget standing desks for small apartments (2026)"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => setTitleTouched(true)}
                />
                {titleInvalid && <div className="field-error">Give the piece a topic or title.</div>}
              </div>

              <div className="field">
                <label htmlFor="mt-instructions">
                  Instructions for the agents <span className="opt">OPTIONAL</span>
                </label>
                <textarea
                  id="mt-instructions"
                  className="textarea"
                  placeholder="What angle to take, who the buyer is, products or facts to include, anything to avoid…"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
                <p className="hint">
                  The researcher and writer treat this as authoritative — higher priority than their
                  generic guidance.
                </p>
              </div>

              <div className="select-row">
                <div className="field">
                  <label htmlFor="mt-category">Category</label>
                  <select
                    id="mt-category"
                    className="select"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    {TOPIC_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="mt-posttype">Post type</label>
                  <select
                    id="mt-posttype"
                    className="select"
                    value={postType}
                    onChange={(e) => setPostType(e.target.value)}
                  >
                    {TOPIC_POST_TYPES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label>
                  Reference materials <span className="opt">OPTIONAL</span>
                  <span className="count">
                    {referenceCount}/{MAX_REFERENCES}
                  </span>
                </label>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,text/markdown"
                  multiple
                  hidden
                  onChange={(e) => readFiles(e.target.files)}
                />

                {files.length === 0 ? (
                  <button
                    type="button"
                    className={`dropzone${fileError ? ' invalid' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <div className="dz-icon">📄</div>
                    <div className="dz-main">
                      <b>Upload .md files</b> of research and references
                    </div>
                    <div className="dz-sub">Up to {MAX_REFERENCES} files, 2 MB each</div>
                  </button>
                ) : (
                  <>
                    <div className="file-chips">
                      {files.map((f, i) => (
                        <div className="file-chip" key={`${f.name}-${i}`}>
                          <div className="fc-icon">MD</div>
                          <div className="fc-body">
                            <div className="fc-name">{f.name}</div>
                            <div className="fc-meta">
                              <span className="ok">✓ ready</span>
                              <span>{(f.size / 1024).toFixed(0)} KB</span>
                            </div>
                          </div>
                          <button
                            className="fc-remove"
                            aria-label={`Remove ${f.name}`}
                            onClick={() => removeFile(i)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    {referenceCount < MAX_REFERENCES && (
                      <div className="add-file-row">
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          + Add another file
                        </button>
                      </div>
                    )}
                  </>
                )}

                {fileError && <div className="field-error">{fileError}</div>}

                <div className="or-row">
                  <span>Or paste markdown inline</span>
                </div>

                {pastes.map((value, i) => (
                  <div className="paste-card" key={i}>
                    <div className="paste-card-head">
                      <span className="pc-label">reference-{i + 1}.md · pasted</span>
                      <div className="pc-actions">
                        <button onClick={() => setPastes((p) => p.map((v, j) => (j === i ? '' : v)))}>
                          Clear
                        </button>
                        <button onClick={() => setPastes((p) => p.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </div>
                    </div>
                    <textarea
                      className="paste-mono"
                      placeholder="# Paste your markdown research here"
                      value={value}
                      onChange={(e) => setPastes((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
                    />
                  </div>
                ))}

                <button type="button" className="paste-toggle-btn" onClick={addPaste}>
                  <span className="ptb-label">＋ Paste a markdown block</span>
                  <span className="ptb-chevron">inline</span>
                </button>
              </div>

              <div className="callout violet-callout">
                <span className="ci">✍️</span>
                <span>
                  Your instructions and references are stored with the topic and injected into the
                  researcher and writer as authoritative context — the agents build on them instead
                  of starting from scratch.
                </span>
              </div>
            </div>

            <div className="drawer-foot">
              <span className="foot-status muted">
                {error ? error : issues > 0 ? `${issues} issue${issues > 1 ? 's' : ''} to fix` : ''}
              </span>
              <div className="spacer" />
              <div className="action-group">
                <button className="btn secondary" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  className="btn violet-outline"
                  disabled={!formValid || busy}
                  onClick={() => setConfirmOpen(true)}
                >
                  {submitting === 'approve' ? 'Starting…' : 'Approve & start now'}
                </button>
                <button className="btn violet" disabled={!formValid || busy} onClick={onSaveDraft}>
                  {submitting === 'draft' ? 'Saving draft…' : 'Save as draft'}
                </button>
              </div>
            </div>
          </>
        )}

        {confirmOpen && (
          <div className="confirm-overlay" onMouseDown={(e) => e.target === e.currentTarget && setConfirmOpen(false)}>
            <div className="confirm-modal" role="alertdialog" aria-modal="true">
              <h3>Start a generation run?</h3>
              <p className="muted">
                This approves the topic and immediately starts research and writing for:
              </p>
              <p className="confirm-topic">“{title.trim()}”</p>
              <p className="muted">Generation runs cost tokens - approve only when the brief is ready.</p>
              <div className="confirm-actions">
                <button className="btn secondary" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </button>
                <button className="btn violet" onClick={onConfirmApprove}>
                  Approve &amp; start now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
