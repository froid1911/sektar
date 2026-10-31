// Dumps every mail row since a date from the switchboard's mail index.
import { writeFileSync } from "node:fs";
const SINCE = process.argv[2] ?? "2026-07-01";
const OUT = process.argv[3];
const gql = async (query, variables) => {
  const r = await fetch("http://localhost:7540/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
};
const drive = await fetch("http://localhost:7540/d/mail").then((r) => r.json());
const rows = [];
for (const view of ["INBOX", "ARCHIVED"]) {
  let cursor = null;
  for (;;) {
    const d = await gql(
      `query ($d: String!, $c: String, $v: MailView) { emailIndex { messages(driveId: $d, view: $v, cursor: $c, limit: 200) { nextCursor items { id accountAddress subject fromName fromAddress snippet when attachmentCount attachmentRefs labels } } } }`,
      { d: drive.id, c: cursor, v: view },
    );
    const page = d.emailIndex.messages;
    rows.push(...page.items.filter((r) => r.when >= SINCE));
    const last = page.items.at(-1);
    if (!page.nextCursor || !last || last.when < SINCE) break;
    cursor = page.nextCursor;
  }
}
writeFileSync(OUT, JSON.stringify(rows));
console.log(rows.length, "rows since", SINCE, "· oldest", rows.at(-1)?.when);
