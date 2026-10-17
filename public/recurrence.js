// When recurring posts are due. No browser code in here, so it can be tested on its own.
// A rule is { kind: "weekly" | "monthly", weekday: 0-6 (0 = Sunday), nth?: 1-5 (monthly; 5 = the last), time: "HH:MM", defaults?: {} }.
// Everything is in the local time zone of whoever is looking.

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "last" };

/** "09:00" -> "9:00 AM" */
export function formatTime(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Plain English for a rule, for example "Every Monday at 9:00 AM" or "2nd Thursday of the month at 9:00 AM". */
export function describeRule(rule) {
  const day = WEEKDAYS[rule.weekday];
  return rule.kind === "monthly"
    ? `${ORDINAL[rule.nth] ?? `${rule.nth}th`} ${day} of the month at ${formatTime(rule.time)}`
    : `Every ${day} at ${formatTime(rule.time)}`;
}

const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

/** Does this rule fall on this calendar day? */
export function matchesDay(rule, date) {
  if (date.getDay() !== rule.weekday) return false;
  if (rule.kind === "weekly") return true;
  if (rule.nth === 5) return date.getDate() + 7 > daysInMonth(date); // the last one of the month
  return Math.ceil(date.getDate() / 7) === rule.nth;
}

/**
 * The times this rule falls on, from the start of `from`'s day for `days` days.
 * @returns {Date[]}
 */
export function occurrences(rule, from, days) {
  const [h, m] = rule.time.split(":").map(Number);
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (matchesDay(rule, day)) out.push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m));
  }
  return out;
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** A local calendar day as YYYY-MM-DD, the form skips are kept in. */
export function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * What is due in the next `days` days, soonest first, and whether each has already been scheduled
 * (a post made from that template that goes out on that day).
 * @param {{ id: number, name: string, active: boolean, rules: object[] }[]} templates
 * @param {{ templateId?: number | null, scheduledAt: string }[]} posts
 * @param {Record<number, string[]>} skips  days (YYYY-MM-DD) each template is skipped, because it isn't happening that week
 */
export function dueList(templates, posts, from, days = 7, skips = {}) {
  const scheduledDays = new Map();
  for (const post of posts) {
    if (post.templateId == null) continue;
    if (!scheduledDays.has(post.templateId)) scheduledDays.set(post.templateId, new Set());
    scheduledDays.get(post.templateId).add(dayKey(new Date(post.scheduledAt)));
  }
  const out = [];
  for (const template of templates) {
    if (!template.active) continue;
    for (const rule of template.rules ?? []) {
      for (const when of occurrences(rule, from, days)) {
        out.push({
          template,
          rule,
          when,
          scheduled: scheduledDays.get(template.id)?.has(dayKey(when)) ?? false,
          skipped: (skips[template.id] ?? []).includes(isoDay(when)),
        });
      }
    }
  }
  return out.sort((a, b) => a.when - b.when || a.template.name.localeCompare(b.template.name));
}

/**
 * The soonest time a template is due on or after `from` (looking up to a year ahead), with the rule that produced it.
 * @returns {{ when: Date, rule: object } | null}
 */
export function nextDue(template, from) {
  let best = null;
  for (const rule of template.rules ?? []) {
    const when = occurrences(rule, from, 400).find((d) => d >= from);
    if (when && (!best || when < best.when)) best = { when, rule };
  }
  return best;
}
