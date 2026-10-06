// The logo, in the theme's colours (lib/prefs.js): a black tile in light, a white one in dark.

import { logo } from "../lib/prefs.js";
import { useEvent } from "./hooks.js";

export function Logo({ className = "brand-icon", ...props }) {
  useEvent("theme:changed");
  return <img className={className} src={logo()} alt="hafen" width="32" height="32" {...props} />;
}
