// Shared by the browser (the Stats tab) and the tests: the list of numbers, and adding them up.

/** In the order the tab shows them. `label` is what people read. */
export const METRICS = [
  { key: "views", label: "Views" },
  { key: "reach", label: "Reach" },
  { key: "viewers", label: "Viewers" },
  { key: "engagements", label: "Engagements" },
  { key: "interactions", label: "Content interactions" },
  { key: "link_clicks", label: "Link clicks" },
  { key: "visits", label: "Visits" },
  { key: "follows", label: "Follows" },
  { key: "shares", label: "Shares" },
  { key: "comments", label: "Comments" },
  { key: "likes", label: "Likes" },
  { key: "saves", label: "Saves" },
];

/** Which numbers at least one row has, in display order. Empty columns are left out of the tables. */
export function metricsPresent(rows) {
  return METRICS.filter((m) => rows.some((r) => typeof r.metrics?.[m.key] === "number"));
}

/**
 * Groups rows and adds each number up. `keyOf` names the group a row belongs to.
 * A number is only added for rows that report it, and a group shows "no figure" (undefined) for a number nobody in it reported,
 * so a channel that can't say "reach" doesn't look like it had zero.
 */
export function summarise(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    let group = groups.get(key);
    if (!group) {
      group = { key, posts: 0, withNumbers: 0, totals: {} };
      groups.set(key, group);
    }
    group.posts += 1;
    if (row.metrics && Object.keys(row.metrics).length) group.withNumbers += 1;
    for (const [metric, value] of Object.entries(row.metrics ?? {})) {
      if (typeof value === "number") group.totals[metric] = (group.totals[metric] ?? 0) + value;
    }
  }
  return [...groups.values()];
}

/** 12345 -> "12,345"; undefined -> an en dash. */
export function formatCount(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : "–";
}
