import readline from "node:readline";

/** Asks a question without showing what's typed (for passphrases). */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const writeToOutput = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    // Let the question through, but swallow each typed character.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) writeToOutput(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}
