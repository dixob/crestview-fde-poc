import dotenv from "dotenv";
dotenv.config({ override: true });

import { bootstrapBoard } from "../monday/bootstrap.js";

async function main(): Promise<void> {
  const config = await bootstrapBoard();
  console.log(JSON.stringify(config, null, 2));
}

main().catch((err) => {
  console.error("\n[bootstrap] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
