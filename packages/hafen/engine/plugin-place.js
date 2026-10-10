// Where plugins are found, as a problem naming one that isn't there says it: the folder's plugins/ (the
// command line's), or, in the app, the plugins it keeps (its engine hosts set that, once, as they start).

let place = "the folder's plugins/ or the suite's plugins";

export const pluginsWhere = () => place;
export function setPluginsWhere(text) {
  place = text;
}
