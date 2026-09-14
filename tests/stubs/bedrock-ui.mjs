/**
 * Stand-in for `@minecraft/server-ui`. Forms auto-cancel so the command tests
 * never block on a modal dialog that does not exist outside the game.
 * Every constructed form is recorded so tests can assert which dialog the
 * player actually saw (e.g. "the create form, not a dead-end chat message").
 *
 * A test that needs to *fill in* a form queues the response the game would have
 * returned (`queueFormResponse`). Without that, a text box can only be proven to
 * exist, never to work — and the Talk form is exactly the surface "chat is not
 * working" is about, so it has to be driven, not assumed.
 */
export const shownForms = [];
/** Responses the next `show()` calls return, in order. */
const queued = [];
export function resetShownForms() { shownForms.length = 0; queued.length = 0; }
/** @param {{canceled?:boolean, selection?:number, formValues?:any[]}} response */
export function queueFormResponse(response) { queued.push(response); return response; }
function next() { return queued.length ? queued.shift() : null; }

class Form {
  constructor(kind) { this.kind = kind; this.titleText = ""; this.bodyText = ""; shownForms.push(this); }
  title(value) { this.titleText = value; return this; }
  body(value) { this.bodyText = value; return this; }
}

export class ActionFormData extends Form {
  constructor() { super("action"); this.buttons = []; }
  button(text) { this.buttons.push(text); return this; }
  async show() { return next() ?? { canceled: true, selection: undefined }; }
}

export class ModalFormData extends Form {
  constructor() { super("modal"); this.fields = []; this.labels = []; this.headers = []; }
  label(text) { this.labels.push(text); return this; }
  header(text) { this.headers.push(text); return this; }
  divider() { this.labels.push("—"); return this; }
  submitButton() { return this; }
  dropdown(label, options, defaultValue) { this.fields.push({ kind: "dropdown", label, options, defaultValue }); return this; }
  textField(label, placeholder, defaultValue) { this.fields.push({ kind: "textField", label, placeholder, defaultValue }); return this; }
  toggle(label, defaultValue) { this.fields.push({ kind: "toggle", label, defaultValue }); return this; }
  slider(label, min, max, step, defaultValue) { this.fields.push({ kind: "slider", label, min, max, step, defaultValue }); return this; }
  async show() { return next() ?? { canceled: true, formValues: undefined }; }
}

export class MessageFormData extends Form {
  constructor() { super("message"); this.first = ""; this.second = ""; }
  button1(text) { this.first = text; return this; }
  button2(text) { this.second = text; return this; }
  async show() { return next() ?? { canceled: true, selection: undefined }; }
}
