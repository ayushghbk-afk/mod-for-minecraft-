/**
 * Stand-in for `@minecraft/server-ui`. Forms auto-cancel so the command tests
 * never block on a modal dialog that does not exist outside the game.
 * Every constructed form is recorded so tests can assert which dialog the
 * player actually saw (e.g. "the create form, not a dead-end chat message").
 */
export const shownForms = [];
export function resetShownForms() { shownForms.length = 0; }

class Form {
  constructor(kind) { this.kind = kind; this.titleText = ""; this.bodyText = ""; shownForms.push(this); }
  title(value) { this.titleText = value; return this; }
  body(value) { this.bodyText = value; return this; }
}

export class ActionFormData extends Form {
  constructor() { super("action"); this.buttons = []; }
  button(text) { this.buttons.push(text); return this; }
  async show() { return { canceled: true, selection: undefined }; }
}

export class ModalFormData extends Form {
  constructor() { super("modal"); this.fields = []; }
  dropdown(label, options, defaultValue) { this.fields.push({ kind: "dropdown", label, options, defaultValue }); return this; }
  textField(label, placeholder, defaultValue) { this.fields.push({ kind: "textField", label, placeholder, defaultValue }); return this; }
  toggle(label, defaultValue) { this.fields.push({ kind: "toggle", label, defaultValue }); return this; }
  slider(label, min, max, step, defaultValue) { this.fields.push({ kind: "slider", label, min, max, step, defaultValue }); return this; }
  async show() { return { canceled: true, formValues: undefined }; }
}

export class MessageFormData extends Form {
  constructor() { super("message"); this.first = ""; this.second = ""; }
  button1(text) { this.first = text; return this; }
  button2(text) { this.second = text; return this; }
  async show() { return { canceled: true, selection: undefined }; }
}
