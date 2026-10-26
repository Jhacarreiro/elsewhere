// Stand-in generator for tests: reads the request on stdin and replies according to its mode.
import { readFileSync } from "node:fs";

const mode = process.argv[2] || "cite";
const request = JSON.parse(readFileSync(0, "utf8"));
if (mode === "fail") process.exit(3);
if (mode === "garbage") {
  process.stdout.write("not json");
  process.exit(0);
}
if (mode === "echo") {
  process.stdout.write(JSON.stringify({ alternatives: [{ summary: JSON.stringify(request.artifacts.map((a) => a.path)), assumptions: [{ text: "Seen", citations: [{ ref: "a1", quote: request.artifacts[0].content.slice(0, 10) }] }], potential_consequences: [], uncertainty: { level: "low" } }] }));
  process.exit(0);
}
const [first] = request.artifacts;
process.stdout.write(JSON.stringify({
  alternatives: [
    {
      summary: "Ask the owner before approving",
      assumptions: [
        { text: "The plan says what it needs", citations: [{ ref: first.ref, quote: first.content.slice(0, 12) }, { ref: first.ref, quote: "a quote that is not in the file" }] },
        { text: "Review would take a day" },
      ],
      potential_consequences: ["Might delay the run"],
      uncertainty: { level: "high", note: "Only one artifact" },
    },
    { summary: "Cite something that does not exist", assumptions: [{ text: "Invented", citations: [{ ref: "a99", quote: "x" }] }], potential_consequences: [], uncertainty: { level: "bogus" } },
    { summary: "Only a guess", assumptions: [{ text: "No basis" }], potential_consequences: [], uncertainty: { level: "low" } },
  ],
}));
