import { cp } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
await cp(
  path.join(root, "src", "database", "migrations"),
  path.join(root, "dist", "database", "migrations"),
  { recursive: true }
);
