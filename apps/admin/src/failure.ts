/**
 * What a failed card says about itself, in the one line an operator reads
 * before deciding whether to open it.
 *
 * The pipeline classifies every stage failure (agent pipeline/failures.ts) and
 * auto-retries the transient ones. By the time a card is on the board as
 * failed, the interesting question is no longer "did it fail" - the red status
 * badge already says so - it is "does this need me, or does it just need
 * running again". That is the whole job of this badge.
 *
 * Pure and dependency-free so it can be unit-tested (see failure.test.ts).
 */

export interface FailureNote {
  /** The imperative: what this failure asks of the operator. */
  label: string;
  /** Label plus the attempt count - the one-line badge on the board. */
  badge: string;
  /** A badge colour class the stylesheet already defines. */
  tone: 'red' | 'amber';
  /** The hover explanation - the part that tells an operator what to do. */
  title: string;
}

interface FailedArticle {
  status: string;
  failure_class: string | null;
  stage_attempts: number;
}

export function failureNote(article: FailedArticle): FailureNote | null {
  if (article.status !== 'failed') return null;

  const attempts = article.stage_attempts ?? 0;
  const tried = attempts > 1 ? ` · ${attempts} attempts` : '';

  switch (article.failure_class) {
    case 'transient':
      return {
        label: 'retry it',
        badge: `retry it${tried}`,
        tone: 'amber',
        title:
          'A model or network fault, not a problem with the article: malformed JSON, a timeout, ' +
          'a dropped connection or a throttled provider. The pipeline already retried it and kept ' +
          'hitting the same fault. Running it again is usually all it needs.',
      };
    case 'genuine':
      return {
        label: 'needs a human',
        badge: `needs a human${tried}`,
        tone: 'red',
        title:
          'The stage rejected the content itself - a contract violation, evidence that is not ' +
          'there, or a failed validation. It was not retried because another run reaches the same ' +
          'verdict. Read the message and fix the brief, the dossier or the draft.',
      };
    // A card that failed before the taxonomy existed carries no class. Say
    // nothing rather than guess at it - the error message is still there.
    default:
      return null;
  }
}
