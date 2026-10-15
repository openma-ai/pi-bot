# Conversation bubble identity colors

Inspected user reference `libfile_85bb912775408191bee37fa7e7a94018` directly. Previously the active teal avatar and hardcoded orange outgoing bubbles disagreed.

`src/gui/identity-color.ts` now owns the six existing identity fallback colors, custom-color normalization/validation, and accessible bubble foreground selection. BotAvatar and the active single-bot conversation use the same resolver. The selected bot is resolved directly from current snapshot/selection on every render, with no cached tint state. Pins, other bot IDs and previous conversations do not determine the tint. Existing avatar data is never rewritten. Group/peer contexts use neutral `#dededc`; assistant bubbles remain the existing dark neutral surface.

Foreground is chosen from dark/white/black to reach at least4.5:1 WCAG contrast, with no hue modification to the identity background. Links/quotes inherit readable bubble ink; code blocks and semantic task-failure cards retain their own dark surfaces. Palette calculation is independent of surrounding light/dark theme; native screenshots exercised the existing dark app theme. A complete light-theme UI is not introduced or claimed verified.

## Checks

- `npm run gui:check`: passed.
- `npx tsc --noEmit`: passed.
- `node --import tsx --test test/gui-identity-color.test.ts test/gui-presentation.test.ts`:12 passed.
- Color tests cover custom/missing/invalid colors, no data mutation, independent group palette, switching identity inputs, all six defaults, black/white/midtones and4096 sampled RGB colors; each foreground/background pair has contrast≥4.5.
- Production GUI bundle and native macOS debug app build passed.
- Native fixture conversations: teal→purple→custom dark→custom light→group→teal. Each outgoing bubble matched the active header/sidebar identity; group stayed neutral regardless of member colors. Assistant replies remained dark neutral. Custom dark used white text; light custom and group used dark text.
- Actual contrast ratios: teal `#48b39f`/`#111111`7.40; purple `#9a7ce0`/`#111111`5.69; custom dark `#173252`/white13.01; custom light `#f2e8bf`/`#111111`15.35; group `#dededc`/`#111111`14.02.

The fixture's optional `--bubble-colors` creates only dummy custom bots and one dummy group in its isolated /tmp data directory. The mock factory emits deterministic replies and runs no external actions. Only that fixture and the development client were restarted; original user daemon processes were not touched.

## Library captures (version0)

- Teal: `libfile_c3133271e9f08191899a80e4313d5d13`
- Purple: `libfile_f80bfb798d08819181ed3fb84bb92f13`
- Group: `libfile_c879179b74a88191aa44cbc492c474ba`
- Custom dark: `libfile_7657a3fc87088191a6c65754c27121ab`
- Custom light: `libfile_1e6fa8bd7264819191c8a958542c0dfa`

All are actual native fixture screenshots, inspected before upload, with no real credentials/private runtime data. No push, publication, real remote access or installer replacement. Real iOS device rendering and a full light-theme render remain unverified; pure palette contrast is theme-independent.
