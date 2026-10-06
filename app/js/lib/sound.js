// Short sounds, synthesized (no audio files): chime("done") rises, chime("failed") falls. Browsers
// only let a page play sound once it has been clicked or typed in; until then this is silent. WebKit
// (Safari) is stricter: the sound must have been started during a click or key press, so it's
// started at the first one, and later chimes (a conversion ending) play.

let audio = null;

const unlock = () => {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume();
  } catch {}
  for (const type of ["pointerdown", "keydown"]) removeEventListener(type, unlock, true);
};
// (a page's: imported elsewhere, Node's tests, there's nothing to listen to)
if (typeof addEventListener === "function") for (const type of ["pointerdown", "keydown"]) addEventListener(type, unlock, true);

const NOTES = {
  done: [[659.25, 0], [987.77, 0.13]],   // E5, then B5
  failed: [[392, 0], [261.63, 0.16]],    // G4, then C4
};

export function chime(kind = "done") {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume();
    for (const [frequency, delay] of NOTES[kind] ?? NOTES.done) {
      const at = audio.currentTime + delay;
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      tone.type = "sine";
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, at);
      volume.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      tone.connect(volume).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.5);
    }
  } catch {
    // No audio (blocked or unsupported): the notification still shows.
  }
}
