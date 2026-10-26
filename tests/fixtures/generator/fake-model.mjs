// Stand-in model CLI for tests: reads a plain-text prompt on stdin and answers in its mode.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2] || "fenced";
const text = readFileSync(0, "utf8");
if (mode === "fail") process.exit(4);
if (mode === "slow") {
  setTimeout(() => process.stdout.write('{"alternatives": []}'), 60000);
} else if (mode === "fork-slow") {
  // A wrapper whose real model is a child: the child's pid goes to the file named next.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  writeFileSync(process.argv[3], String(child.pid));
  setTimeout(() => {}, 60000);
} else if (mode === "stubborn") {
  // Ignores the request to stop, so only a kill ends it.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  // Prints past the adapter's limit and never finishes.
  const chunk = "x".repeat(1024 * 1024);
  const write = () => process.stdout.write(chunk, write);
  write();
} else if (mode === "env") {
  // Answers with the environment variable named next, with no alternatives.
  process.stdout.write(JSON.stringify({ alternatives: [], value: process.env[process.argv[3]] ?? null }));
} else if (mode === "peek") {
  // Answers whether the file named next is visible, with no alternatives.
  process.stdout.write(JSON.stringify({ alternatives: [], seen: existsSync(process.argv[3]) }));
} else if (mode === "canary") {
  // Runs the command the canary asks for and copies its output, as a model running it would.
  const command = text.split("\n\n")[1];
  process.stdout.write(JSON.stringify({ alternatives: [], output: execFileSync("sh", ["-c", command], { encoding: "utf8" }) }));
} else if (mode === "prose") {
  process.stdout.write("I would rather not answer in JSON.");
} else {
  // Quote the first line of the first artifact, as a model citing it would.
  const quote = text.split("### a1:")[1].split("\n")[2];
  const reply = { alternatives: [{ summary: "Ask first", assumptions: [{ text: "The plan asks for it", citations: [{ ref: "a1", quote }] }], potential_consequences: [], uncertainty: { level: "medium" } }] };
  process.stdout.write(`Here is my answer.\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\`\nDone {not json}.`);
}
