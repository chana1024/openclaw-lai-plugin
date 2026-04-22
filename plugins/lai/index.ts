import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createLaiCommand, registerLaiInteractiveHandlers } from "./src/lai-command.js";

export default definePluginEntry({
  id: "lai",
  name: "LAI",
  description: "Run the local lai CLI directly as a runtime slash command.",
  register(api) {
    api.registerCommand(createLaiCommand());
    registerLaiInteractiveHandlers(api);
  },
});
