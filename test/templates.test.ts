import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRule, dueList, formatTime, isoDay, matchesDay, nextDue, occurrences } from "../public/recurrence.js";
import { fillTemplate, leftoverPlaceholders, placeholdersOf } from "../public/template-text.js";

describe("filling in a template", () => {
  const body = `❓#QuestionOfTheWeek {{question}}

{{video link?}}

{{details}}

{{G2G link}}

#Genealogy`;

  it("finds each blank once, in order, and knows which are optional", () => {
    assert.deepEqual(
      placeholdersOf(body).map((p) => [p.name, p.optional]),
      [["question", false], ["video link", true], ["details", false], ["G2G link", false]],
    );
    assert.deepEqual(placeholdersOf("{{a}} and {{A}} and {{a?}}").map((p) => [p.key, p.optional]), [["a", true]], "one blank, however it is spelled");
  });

  it("fills them in, and tidies the gap an omitted optional part leaves", () => {
    const text = fillTemplate(body, { question: "Do you have German roots? 🇩🇪", details: "Tell us!", "g2g link": "https://wikitree.com/g2g/1" });
    assert.equal(text, "❓#QuestionOfTheWeek Do you have German roots? 🇩🇪\n\nTell us!\n\nhttps://wikitree.com/g2g/1\n\n#Genealogy");
    const withVideo = fillTemplate(body, { question: "Q", "video link": "https://youtu.be/x", details: "D", "g2g link": "L" });
    assert.match(withVideo, /Q\n\nhttps:\/\/youtu\.be\/x\n\nD/);
  });

  it("leaves a required blank showing, so it can't be forgotten", () => {
    const text = fillTemplate(body, { question: "Q" });
    assert.deepEqual(leftoverPlaceholders(text), ["{{details}}", "{{G2G link}}"]);
    assert.deepEqual(leftoverPlaceholders("Nothing to fill. {not a placeholder} {{ }}"), ["{{ }}"]);
    assert.deepEqual(leftoverPlaceholders("plain text"), []);
  });

  it("uses a default when there is one, and lets an answer override it", () => {
    const body2 = "Q&A TODAY at {{time=8pm ET}}";
    assert.equal(fillTemplate(body2), "Q&A TODAY at 8pm ET");
    assert.equal(fillTemplate(body2, { time: "11am ET" }), "Q&A TODAY at 11am ET");
    assert.equal(placeholdersOf(body2)[0].default, "8pm ET");
  });

  it("can change the case of an answer, and reuse one answer in several places", () => {
    const text = fillTemplate("showcase: {{surname}}\nhttps://www.wikitree.com/genealogy/{{surname|upper}}", { surname: "Smith" });
    assert.equal(text, "showcase: Smith\nhttps://www.wikitree.com/genealogy/SMITH");
    assert.equal(fillTemplate("{{x|lower}}", { x: "ABC" }), "abc");
  });

  it("leaves the template's own wording, emoji and hashtags alone", () => {
    const t = "🌳 Genealogy is better together!\n#GenealogyCollaborationHour TODAY at 17:00 ET\n\nhttps://www.wikitree.com/g2g/1";
    assert.equal(fillTemplate(t), t);
  });
});

describe("when recurring posts are due", () => {
  // 12 October 2026 is a Monday
  const monday = new Date(2026, 9, 12, 8, 0);
  const weekly = (weekday: number, time = "09:00") => ({ kind: "weekly", weekday, time });
  const monthly = (nth: number, weekday: number, time = "09:00") => ({ kind: "monthly", nth, weekday, time });

  it("describes a rule in plain English", () => {
    assert.equal(describeRule(weekly(1)), "Every Monday at 9:00 AM");
    assert.equal(describeRule(monthly(2, 4, "20:30")), "2nd Thursday of the month at 8:30 PM");
    assert.equal(describeRule(monthly(5, 0, "00:00")), "last Sunday of the month at 12:00 AM");
    assert.equal(formatTime("12:05"), "12:05 PM");
  });

  it("finds every week's day", () => {
    assert.ok(matchesDay(weekly(1), new Date(2026, 9, 12)));
    assert.ok(!matchesDay(weekly(1), new Date(2026, 9, 13)));
    const days = occurrences(weekly(6, "10:30"), monday, 14).map((d) => d.getDate());
    assert.deepEqual(days, [17, 24]);
    assert.equal(occurrences(weekly(6, "10:30"), monday, 14)[0].getHours(), 10);
  });

  it("finds the 2nd and 4th weekday of a month, and the last", () => {
    // October 2026: Thursdays are 1, 8, 15, 22, 29; Sundays are 4, 11, 18, 25
    const oct = new Date(2026, 9, 1);
    assert.deepEqual(occurrences(monthly(2, 4), oct, 31).map((d) => d.getDate()), [8]);
    assert.deepEqual(occurrences(monthly(4, 0), oct, 31).map((d) => d.getDate()), [25]);
    assert.deepEqual(occurrences(monthly(1, 4), oct, 31).map((d) => d.getDate()), [1]);
    assert.deepEqual(occurrences(monthly(5, 4), oct, 31).map((d) => d.getDate()), [29], "last Thursday");
    assert.deepEqual(occurrences(monthly(5, 0), oct, 31).map((d) => d.getDate()), [25], "last Sunday");
    // a month where the last one is the 4th: February 2026 Sundays are 1, 8, 15, 22
    assert.deepEqual(occurrences(monthly(5, 0), new Date(2026, 1, 1), 28).map((d) => d.getDate()), [22]);
  });

  it("lists what is due this week, soonest first, marking what is already scheduled", () => {
    const templates = [
      { id: 1, name: "QoW", active: true, rules: [weekly(1)] },
      { id: 2, name: "ONS", active: true, rules: [weekly(2)] },
      { id: 3, name: "CC", active: true, rules: [weekly(2)] },
      { id: 4, name: "Old", active: false, rules: [weekly(3)] },
      { id: 5, name: "FDN", active: true, rules: [] },
    ];
    const posts = [{ templateId: 2, scheduledAt: new Date(2026, 9, 13, 9, 0).toISOString() }];
    const list = dueList(templates, posts, monday, 7);
    assert.deepEqual(list.map((d) => [d.template.name, d.when.getDate(), d.scheduled]), [
      ["QoW", 12, false],
      ["CC", 13, false],
      ["ONS", 13, true],
    ]);
  });

  it("only counts a post for the day it goes out, not for other weeks", () => {
    const templates = [{ id: 1, name: "QoW", active: true, rules: [weekly(1)] }];
    const nextWeek = [{ templateId: 1, scheduledAt: new Date(2026, 9, 19, 9, 0).toISOString() }];
    assert.equal(dueList(templates, nextWeek, monday, 7)[0].scheduled, false);
    const sameDay = [{ templateId: 1, scheduledAt: new Date(2026, 9, 12, 18, 0).toISOString() }];
    assert.equal(dueList(templates, sameDay, monday, 7)[0].scheduled, true);
  });

  it("marks what has been skipped for a week, so it can be set aside without being forgotten", () => {
    const templates = [{ id: 1, name: "Project Showcase", active: true, rules: [weekly(4)] }];
    const thursday = new Date(2026, 9, 15, 9, 0);
    assert.equal(isoDay(thursday), "2026-10-15");
    assert.deepEqual(dueList(templates, [], monday, 7, { 1: ["2026-10-15"] }).map((d) => [d.when.getDate(), d.skipped]), [[15, true]]);
    assert.equal(dueList(templates, [], monday, 7, { 1: ["2026-10-22"] })[0].skipped, false, "a different week is not skipped");
    assert.equal(dueList(templates, [], monday, 7)[0].skipped, false);
  });

  it("finds the next time a template is due, across its schedule lines", () => {
    const qa = { rules: [monthly(2, 4), monthly(4, 0)] };
    const next = nextDue(qa, monday)!;
    assert.deepEqual([next.when.getMonth(), next.when.getDate()], [9, 25], "the 4th Sunday of October comes before the 2nd Thursday of November");
    assert.equal(nextDue({ rules: [] }, monday), null);
  });
});
