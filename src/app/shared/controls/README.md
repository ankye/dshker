# Shared themed controls

Cross-domain presentation controls that replace native form widgets whose
popups cannot carry the application palette.

- `ThemedListbox.vue` — single-select ARIA listbox replacing the native select element.

These controls own presentation and keyboard semantics only. They hold no
product workflow, no IPC access, and no domain state.
