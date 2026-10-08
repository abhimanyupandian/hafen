// A part of the app that can't be drawn (a file written in a way nothing foresaw, say) says so, in its
// own place, rather than leaving the whole window blank: the sidebar's sections, the thread, the
// panel, the timeline each on their own. It tries again when what's selected or the files change, or
// when asked ("try again").

import { Component, useMemo } from "react";
import { useStore } from "../design/hooks.js";
import { say } from "../lib/log.js";
import { app } from "../state.js";

class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, at: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  // Drawn again once what it shows has changed since it failed
  static getDerivedStateFromProps(props, state) {
    if (state.error && state.at !== null && props.resetKey !== state.at) return { error: null, at: null };
    return null;
  }

  componentDidCatch(error) {
    this.setState({ at: this.props.resetKey });
    say(`${this.props.what} couldn't be shown: ${error?.message ?? error}`, "err");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`crash ${this.props.fallbackClass ?? ""}`} role="alert" id={this.props.id}>
        <p className="note placeholder">{`${this.props.what} couldn't be shown: ${error?.message ?? error}`}</p>
        <button className="btn btn-ghost" type="button" onClick={() => this.setState({ error: null, at: null })}>try again</button>
      </div>
    );
  }
}

// what: what it is ("The conversation"); fallbackClass: the class its place has (so it keeps its room)
export function Guard({ what, id, fallbackClass, children }) {
  const { selection, suites } = useStore(app);
  // (the same object until the selection or the files change: a failure isn't retried over and over)
  const resetKey = useMemo(() => ({}), [selection, suites]);
  return <Boundary what={what} id={id} fallbackClass={fallbackClass} resetKey={resetKey}>{children}</Boundary>;
}
