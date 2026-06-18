# Character Wallet

Standalone SillyTavern extension for tracking `{{char}}`'s wallet through the main generation profile.

It injects one compact system instruction into the normal chat generation, asks the model to append a hidden `<char_wallet_state>` JSON block, stores the parsed state in `chatMetadata`, and renders a floating wallet panel.

The wallet is intentionally character-owned: purchases made only by `{{user}}` should not change it unless `{{char}}` pays, earns, owes, receives, lends, borrows, or is otherwise financially affected.

## Install

In SillyTavern, open Extensions, choose the option to install a third-party extension from a Git URL, and use:

```text
https://github.com/americangardens/wallet
```

After installation, enable **Character Wallet** in the extensions list.
