# PLUGIN REGISTRY

## State Legend

- **💡 Ideated** - Creative brief exists, no implementation
- **💡 Ideated (Draft Params)** - Creative brief + draft parameters, ready for parallel workflow
- **🚧 Stage N** - In development (specific stage number)
- **✅ Working** - Completed Stage 6, not installed
- **📦 Installed** - Deployed to system folders
- **🐛 Has Issues** - Known problems (combines with other states)
- **🗑️ Archived** - Deprecated

## State Machine Rules

- If status is 🚧: ONLY plugin-workflow can modify (use `/continue` to resume)
- plugin-improve blocks if status is 🚧 (must complete workflow first)

## Build Management

- All plugin builds managed by `build-automation` skill
- Build logs: `logs/[PluginName]/build_TIMESTAMP.log`
- Installed plugins: `~/Library/Audio/Plug-Ins/VST3/` and `~/Library/Audio/Plug-Ins/Components/`

## Plugin Registry

| Plugin Name | Status | Version | Type | Last Updated |
|-------------|--------|---------|------|--------------|

| JazzGptMidi | 📦 Installed | 1.0.0 | Utility (Text-to-MIDI Converter) | 2026-02-04 |
| Coltranator | 💡 Ideated | - | Instrument (Sampler) | 2026-02-26 |
| ChordGPT | 🚧 Stage 1 | - | MIDI Generator + Instrument | 2026-03-17 |
| PianoTransformer | 🚧 Stage 0 | - | Utility (AI MIDI Generator) | 2026-03-27 |

**For detailed plugin information (lifecycle timeline, known issues, parameters, etc.), see:**
`plugins/[PluginName]/NOTES.md`

## Entry Template

When adding new plugins to this registry, use this format:

```markdown
| [PluginName] | [Emoji] [State] | [X.Y.Z or -] | [Type or -] | YYYY-MM-DD |
```

Create corresponding `plugins/[PluginName]/NOTES.md` with full details:

```markdown
# [PluginName] Notes

## Status
- **Current Status:** [emoji] [State Name]
- **Version:** [X.Y.Z or N/A]
- **Type:** [Type]

## Lifecycle Timeline

- **YYYY-MM-DD:** [Event description]
- **YYYY-MM-DD (Stage N):** [Stage completion description]
- **YYYY-MM-DD (vX.Y.Z):** [Version release description]

## Known Issues

[Issue description or "None"]

## Additional Notes

[Any other relevant information - description, parameters, DSP, GUI, validation, formats, installation locations, use cases, etc.]
```
