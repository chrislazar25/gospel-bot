export const STATES = ['new', 'triage', 'other', 'bug', 'no-repro', 'fixing', 'pr', 'blocked', 'merged'] as const;
export type State = (typeof STATES)[number];

export const REPORT_LABEL = 'benny:report';
export const BOT_PREFIX = '🤖 ';

export const TABLE: Record<State, { label: string | null; emoji: string; reply: string | null; rank: number }> = {
  new: { label: 'benny:new', emoji: '👀', reply: null, rank: 0 },
  triage: { label: 'benny:triage', emoji: '🔎', reply: null, rank: 1 },
  other: { label: 'benny:other', emoji: '💬', reply: "Looked into this. It's not a bug. Chris will follow up.", rank: 2 },
  bug: { label: 'benny:bug', emoji: '🐞', reply: null, rank: 2 },
  'no-repro': { label: 'benny:no-repro', emoji: '🤔', reply: "Couldn't make this happen. Can you tell me more about what you saw?", rank: 2 },
  fixing: { label: 'benny:fixing', emoji: '🛠️', reply: null, rank: 3 },
  pr: { label: 'benny:pr', emoji: '📬', reply: 'A fix is ready. Chris will review it.', rank: 4 },
  blocked: { label: 'benny:blocked', emoji: '🙋', reply: "I'm stuck on this one. Chris will take a look.", rank: 4 },
  merged: { label: null, emoji: '✅', reply: 'Fixed. Thanks for reporting!', rank: 5 },
};

export type Issue = { number: number; state: 'open' | 'closed'; stateReason: string | null; labels: string[] };

export function stateOf(issue: Pick<Issue, 'state' | 'stateReason' | 'labels'>): State {
  if (issue.state === 'closed' && issue.stateReason === 'completed') return 'merged';
  let best: State = 'new';
  for (const s of STATES) if (TABLE[s].label && issue.labels.includes(TABLE[s].label) && TABLE[s].rank > TABLE[best].rank) best = s;
  return best;
}
