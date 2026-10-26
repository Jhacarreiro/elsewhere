// Stand-in model CLI for tests: reads a plain-text prompt on stdin and answers in its mode.
import { readFileSync } from "node:fs";

const mode = process.argv[2] || "fenced";
const text = readFileSync(0, "utf8");
if (mode === "fail") process.exit(4);
if (mode === "slow") {
  setTimeout(() => process.stdout.write('{"alternatives": []}'), 60000);
} else if (mode === "prose") {
  process.stdout.write("I would rather not answer in JSON.");
} else {
  // Quote the first line of the first artifact, as a model citing it would.
  const quote = text.split("### a1:")[1].split("\n")[2];
  const reply = { alternatives: [{ summary: "Ask first", assumptions: [{ text: "The plan asks for it", citations: [{ ref: "a1", quote }] }], potential_consequences: [], uncertainty: { level: "medium" } }] };
  process.stdout.write(`Here is my answer.\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\`\nDone {not json}.`);
}
