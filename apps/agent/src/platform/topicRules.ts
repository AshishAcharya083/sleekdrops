// Topic classes a platform does not cover at all, whoever suggests the topic:
// the scout drops a match, and a manual topic that matches is refused.
import type { Platform, TopicClass } from './types.js';

const TOPIC_CLASS_PATTERNS: Record<TopicClass, RegExp> = {
  // Horse, greyhound and harness racing. Plain "race" ("title race", "race to
  // the playoffs") and motor racing stay allowed. Bare "dogs" is left out
  // because "the Dogs" is the Bulldogs' nickname, bare "harness" because teams
  // harness momentum, and "on the trot" is a winning streak.
  racing: new RegExp(
    String.raw`\b(?:` +
      [
        String.raw`horse[\s-]?rac(?:e|es|ing)`,
        String.raw`race[\s-]?horses?`,
        String.raw`thoroughbreds?`,
        String.raw`jockeys?`,
        String.raw`race[\s-]?(?:meetings?|meets?|courses?)`,
        String.raw`(?:spring|autumn) racing(?: carnival)?`,
        String.raw`greyhounds?`,
        String.raw`dogs? racing`,
        String.raw`harness[\s-]rac(?:e|es|ing)`,
        String.raw`(?<!on the )trots?`,
        String.raw`trotting`,
        String.raw`trotters?`,
        String.raw`pacing`,
        String.raw`melbourne cup`,
        String.raw`caulfield cup`,
        String.raw`cox plate`,
        String.raw`golden slipper`,
        String.raw`kentucky derby`,
        String.raw`grand national`,
        String.raw`royal ascot`,
        String.raw`cheltenham festival`,
        String.raw`inter dominion`,
      ].join('|') +
      String.raw`)\b`,
    'i',
  ),
};

const TOPIC_CLASS_LABELS: Record<TopicClass, string> = {
  racing: 'racing',
};

/**
 * Why `text` (a topic's title, angle or the like) is outside what `platform`
 * covers, in words fit to show the operator - or null when it is allowed.
 */
export function blockedTopicReason(
  platform: Pick<Platform, 'name' | 'blockedTopics'>,
  text: string,
): string | null {
  for (const topicClass of platform.blockedTopics) {
    if (TOPIC_CLASS_PATTERNS[topicClass].test(text)) {
      return `${TOPIC_CLASS_LABELS[topicClass]} topics are not covered on ${platform.name}`;
    }
  }
  return null;
}
