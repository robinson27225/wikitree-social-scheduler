// Template text with {{placeholders}}. No browser code in here, so it can be tested on its own.
//
//   {{name}}               a required blank
//   {{name=default}}       pre-filled with a default
//   {{name?}}              optional: may be left blank, and then it is left out
//   {{name|upper}}         the value in CAPITALS  (also |lower)
//
// The same name used twice is asked for once.

const PLACEHOLDER = /\{\{\s*([^{}|=?]+?)\s*(\?)?\s*(?:=\s*([^{}|]*?))?\s*(?:\|\s*(upper|lower)\s*)?\}\}/g;

const keyOf = (name) => name.trim().toLowerCase();

/**
 * The blanks in a template, in the order they first appear.
 * @param {string} body
 * @returns {{ key: string, name: string, optional: boolean, default: string }[]}
 */
export function placeholdersOf(body) {
  const found = new Map();
  for (const m of String(body).matchAll(PLACEHOLDER)) {
    const key = keyOf(m[1]);
    const existing = found.get(key);
    if (!existing) found.set(key, { key, name: m[1].trim(), optional: Boolean(m[2]), default: (m[3] ?? "").trim() });
    else {
      existing.optional = existing.optional || Boolean(m[2]);
      if (!existing.default && m[3]) existing.default = m[3].trim();
    }
  }
  return [...found.values()];
}

/**
 * The text with the blanks filled in. A required blank with no answer is left showing as {{name}}, so it can't be missed.
 * Blank lines left by omitted optional parts are tidied up.
 * @param {string} body
 * @param {Record<string, string>} values  answers by lower-case name; anything missing falls back to its default
 */
export function fillTemplate(body, values = {}) {
  const defaults = new Map(placeholdersOf(body).map((p) => [p.key, p]));
  const filled = String(body).replace(PLACEHOLDER, (whole, name, _optional, _default, filter) => {
    const key = keyOf(name);
    const spec = defaults.get(key);
    let value = values[key];
    if (value === undefined || value === null) value = spec?.default ?? "";
    value = String(value).trim();
    if (value === "") return spec?.optional ? "" : whole;
    return filter === "upper" ? value.toUpperCase() : filter === "lower" ? value.toLowerCase() : value;
  });
  return filled
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Any {{...}} left in some text.
 * @param {string} text
 * @returns {string[]}
 */
export function leftoverPlaceholders(text) {
  return [...String(text).matchAll(/\{\{[^{}]*\}\}/g)].map((m) => m[0]);
}
