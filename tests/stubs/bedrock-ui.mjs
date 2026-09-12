/**
 * Stand-in for `@minecraft/server-ui`. Forms auto-cancel so the command tests
 * never block on a modal dialog that does not exist outside the game.
 */
class Form {
  constructor() { this.titleText = ""; this.bodyText = ""; }
  title(value) { this.titleText = value; return this; }
  body(value) { this.bodyText = value; return this; }
}

export class ActionFormData extends Form {
  constructor() { super(); this.buttons = []; }
  button(text) { this.buttons.push(text); return this; }
  async show() { return { canceled: true, selection: undefined }; }
}

export class ModalFormData extends Form {
  constructor() { super(); this.fields = []; }
  dropdown(label, options, defaultValue) { this.fields.push({ kind: "dropdown", label, options, defaultValue }); return this; }
  textField(label, placeholder, defaultValue) { this.fields.push({ kind: "textField", label, placeholder, defaultValue }); return this; }
  toggle(label, defaultValue) { this.fields.push({ kind: "toggle", label, defaultValue }); return this; }
  slider(label, min, max, step, defaultValue) { this.fields.push({ kind: "slider", label, min, max, step, defaultValue }); return this; }
  async show() { return { canceled: true, formValues: undefined }; }
}

export class MessageFormData extends Form {
  button1(text) { this.first = text; return this; }
  button2(text) { this.second = text; return this; }
  async show() { return { canceled: true, selection: undefined }; }
}
