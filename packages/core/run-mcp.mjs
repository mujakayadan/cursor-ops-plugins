import { startServer } from "./mcp-server.mjs";
import provider from "../../provider.mjs";

const flag = process.argv.indexOf("--tier");
const tier = flag >= 0 ? process.argv[flag + 1] : undefined;
if (tier !== "read" && tier !== "write") {
  process.stderr.write("Usage: run-mcp.mjs --tier <read|write>\n");
  process.exit(64);
}
startServer(provider, tier);
