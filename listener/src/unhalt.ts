import { join } from "node:path";
import { STATE_DIR } from "./config";
import { Store } from "./store";

const store = new Store(join(STATE_DIR, "queue.sqlite"));
const was = store.halted();
store.clearHalt();
console.log(was ? `cleared halt (${was}); restart the listener to resume` : "not halted");
