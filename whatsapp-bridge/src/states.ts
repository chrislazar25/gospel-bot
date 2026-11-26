export const STATES = ['new', 'triage', 'other', 'bug', 'no-repro', 'fixing', 'pr', 'blocked', 'merged', 'closed'] as const;
export type State = (typeof STATES)[number];

export const REPORT_LABEL = 'benny:report';
export const RETRIAGE_LABEL = 'benny:triage-again';
export const BOT_PREFIX = '🤖 ';

export const TABLE: Record<State, { label: string | null; emoji: string; reply: string | null; rank: number; terminal: boolean }> = {
  new: { label: 'benny:new', emoji: '👀', reply: null, rank: 0, terminal: false },
  triage: { label: 'benny:triage', emoji: '🔎', reply: null, rank: 1, terminal: false },
  other: { label: 'benny:other', emoji: '💬', reply: "Looked into this. It's not a bug. Chris will follow up.", rank: 2, terminal: false },
  bug: { label: 'benny:bug', emoji: '🐞', reply: null, rank: 2, terminal: false },
  'no-repro': { label: 'benny:no-repro', emoji: '🤔', reply: "Couldn't make this happen. Can you tell me more about what you saw?", rank: 2, terminal: false },
  fixing: { label: 'benny:fixing', emoji: '🛠️', reply: null, rank: 3, terminal: false },
  pr: { label: 'benny:pr', emoji: '📬', reply: 'A fix is ready. Chris will review it.', rank: 4, terminal: false },
  blocked: { label: 'benny:blocked', emoji: '🙋', reply: "I'm stuck on this one. Chris will take a look.", rank: 4, terminal: false },
  merged: { label: null, emoji: '✅', reply: 'Fixed. Thanks for reporting!', rank: 5, terminal: true },
  closed: { label: null, emoji: '💬', reply: 'Chris closed this one.', rank: 5, terminal: true },
};

export type Issue = { number: number; state: 'open' | 'closed'; stateReason: string | null; labels: string[] };

export function stateOf(issue: Pick<Issue, 'state' | 'stateReason' | 'labels'>): State {
  if (issue.state === 'closed') return issue.stateReason === 'completed' ? 'merged' : 'closed';
  let best: State = 'new';
  for (const s of STATES) if (TABLE[s].label && issue.labels.includes(TABLE[s].label) && TABLE[s].rank > TABLE[best].rank) best = s;
  return best;
}
