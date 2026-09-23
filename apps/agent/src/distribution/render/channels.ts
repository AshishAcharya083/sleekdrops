// What one social network can hold, as far as composing copy for it goes.
//
// The renderer is per channel rather than per post because the two networks
// this abstraction has to survive contact with are 200x apart on the only
// dimension that changes the copy: Facebook will take 63,206 characters and
// Bluesky takes 300. Copy written once and shared would be written for the
// generous one and silently truncated on the strict one - and the fixtures a
// caption cannot drop (the disclosure, the placement cue) are what a naive
// truncation cuts first, because they come last.
//
// So a channel is a small record, the renderer budgets against it, and a new
// network is one more entry here.
import type { LinkPlacement } from '../types.js';

export interface ChannelSpec {
  /** The `channel_connections.provider` value this spec is for. */
  name: string;
  /** Characters a caption may run to on this network. */
  captionLimit: number;
  /**
   * Whether the network has a first comment to put a link in at all. False
   * resolves every placement to 'in_body', because a cue pointing at a comment
   * that cannot exist is a post with no destination.
   */
  supportsFirstComment: boolean;
}

/**
 * The networks we know the shape of. Facebook is the one connected today; the
 * other two are the candidates the adapter interface was validated against,
 * and they are here because a 300-character channel is exactly the case this
 * module exists to make cheap.
 */
export const CHANNEL_SPECS: readonly ChannelSpec[] = [
  { name: 'facebook', captionLimit: 63_206, supportsFirstComment: true },
  { name: 'threads', captionLimit: 500, supportsFirstComment: true },
  { name: 'bluesky', captionLimit: 300, supportsFirstComment: true },
];

/**
 * What an unregistered channel is assumed to be: the strictest limit we know
 * of and no comment to post into. Both halves fail safe - copy that fits 300
 * characters fits every network above it, and a link in the body always lands
 * somewhere, where a link in a comment the network does not have does not.
 */
export const UNKNOWN_CHANNEL_LIMIT = 300;

export function channelSpec(name: string): ChannelSpec {
  return (
    CHANNEL_SPECS.find((spec) => spec.name === name) ?? {
      name,
      captionLimit: UNKNOWN_CHANNEL_LIMIT,
      supportsFirstComment: false,
    }
  );
}

/** The placement this channel can actually honour. */
export function placementFor(spec: ChannelSpec, wanted: LinkPlacement): LinkPlacement {
  return spec.supportsFirstComment ? wanted : 'in_body';
}
