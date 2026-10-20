# User Guide

Scenario for Photoshop, development build 0.7.1. Pictures and recordings in this guide come from real runs in Photoshop 27.11 on macOS with the panel docked at 320 px, at each action's default model and smallest settings. Claims carry how they were checked: *verified live* (in Photoshop), *tested automated* (test suite, no Photoshop) or *not tested*.

- [Quick start](#quick-start)
- [Find your way around](#find-your-way-around)
- [Actions](#actions)
- [Selection edits: Inside selection or Bolder](#selection-edits-inside-selection-or-bolder)
- [Takes](#takes)
- [References](#references)
- [Style and trained models](#style-and-trained-models)
- [Library](#library)
- [Prices and approval](#prices-and-approval)
- [Jobs and recovery](#jobs-and-recovery)
- [Settings](#settings)
- [Agents](#agents)
- [Where results are saved](#where-results-are-saved)
- [Troubleshooting](#troubleshooting)
- [Not in this build](#not-in-this-build)

## Quick start

From install to a first image in about two minutes, once the package is built (see the [README](../README.md#install)).

1. **Install** the `.ccx` and restart Photoshop, then open **Plugins > Scenario**. The panel opens on **Connect your Scenario account**.

   <img src="media/screens/first-run-sign-in.png" width="320" alt="The sign-in screen: API key and secret fields, Save and test, and links to create a key">

2. **Get a key.** On app.scenario.com, in the project you want to use, create a **Project key** with the **Editor** role. A CU limit on the key caps what this plugin and connected agents can spend. Only team admins and project owners can create keys; **Copy a request for your admin** prepares the message for them.
3. **Sign in.** Paste the key and the secret (pasting `key:secret`, or the two on two lines, fills both fields) and click **Save and test**. The plugin checks the key with two free reads and keeps it in Photoshop's secure storage on this computer. *Verified live* (through the development key import; typing into the fields *not tested*).
4. **Open a document** (Photoshop hides docked panels on its Home screen, so the panel shows once a document is open). Click **New layer**, type a prompt, and click the blue button, which reads `New layer · 3 CU` or similar.
5. The context card shows the progress (Queued, Generating, Downloading), then the image lands as a new layer in one History state. *Verified live*.

![Sign-in, then a first image on a new layer](media/video/sign-in-to-first-generation.gif)

*[MP4](media/video/sign-in-to-first-generation.mp4). The key was imported outside the frame; the fields are never shown filled.*

## Find your way around

<img src="media/screens/progress-generating.png" width="320" alt="The panel while a run is generating: context card with progress, action chips, composer with prompt, chips and the priced button">

From top to bottom:

- **Header**: the project name (click to switch projects), the agent icon with its dot, and **Jobs** with a count.
- **Context card**: a picture of what the panel will work on and where the result lands ("Lands inside the selection, masked", "Lands as a new layer"), with the progress during a run. Its **Select…** field is [Select by description](#actions).
- **Action chips**: the actions for this context, at most six, then **More** for the others, grouped. A pin in **More** adds an action to the chips.
- **Takes and Recent**: the last run's takes, then the other runs placed in this document.
- **Composer**, pinned at the bottom: **+ Reference**, the prompt (with **Suggest**), the chips that set the model and its options (each shows its value), and the action button with its price. The gear icon holds the quality level and advanced options.

<img src="media/screens/more-menu.png" width="320" alt="The More menu: Finish, Select and cut, Layers, Make variants and Animate groups, each action with its price">

## Actions

What the panel offers depends on what is selected. Each action below was *verified live* on 27.11 unless marked; the pictures are the before and the result of that run.

### Selection actions

Draw a selection with any Photoshop tool. The context card reads "Selection W × H on <layer>".

**Replace inside**: describe what goes inside the selection. Default model Ideogram 4.5 Precise Edit (Inside selection) or GPT Image 2.5 Flare (Bolder), see [the next section](#selection-edits-inside-selection-or-bolder).

![Before, Inside selection, Bolder: a coffee cup replaced by a glass of iced lemonade](media/before-after/replace-inside-cafe.jpg)

**Remove**: removes what is inside the selection and fills it with what should be behind. No prompt needed (a built-in one is sent).

![A traffic cone removed from a beach](media/before-after/remove-beach.jpg)

**Cut out subject**: the subject inside the selection, on a new layer with a transparent background. The layer stays as it was and the selection is dropped in the same History state.

![A dog cut out of a park scene](media/before-after/cut-out-subject-dog.jpg)

**Select by description**: type what to select in the context card's **Select…** field ("all the sailboats"), click **Select**. The masks the model finds become a Photoshop selection, ready for the next action.

![Four sailboats selected from the words "all the sailboats", shown with a pink overlay](media/before-after/select-by-description-harbor.jpg)

*The overlay is drawn from the masks the run returned; in Photoshop you see the usual selection.*

**Make versions** also works on a selection.

### Layer and image actions

With no selection, the panel works on the active layer, or the whole image for a flat document.

**Make versions**: variations of the layer, or the change you describe, as takes to compare.

![A white sneaker, then two takes in forest green suede](media/before-after/make-versions-sneaker.jpg)

**New layer**: a new image on a layer above, from a prompt.

![A lighthouse at golden hour made on a new layer](media/before-after/new-layer-lighthouse.jpg)

**Upscale**: 2x or the other factors the model offers (Topaz Image Upscale), from all visible layers, opened as a new document at the larger size. The result card compares the same region at 100%.

![A barn owl's face at 100%, before and after a 2x upscale](media/before-after/upscale-owl.jpg)

![Upscale from the panel](media/video/upscale.gif)

*[MP4](media/video/upscale.mp4).*

**Remove background**: one click (851 Labs Background Remover); lands as a mask on the layer, so the hidden pixels stay. **Cut out to a new layer** (More) keeps the layer as it is and puts the subject on a masked copy above.

![A perfume bottle with its background removed](media/before-after/remove-background-perfume.jpg)

**Add background**: on a cut-out layer, describe the scene; it lands below the layer at canvas size.

![Headphones on a transparent layer, then on a sunlit shelf](media/before-after/add-background-headphones.jpg)

**Render sketch** (More > Make variants): turns a line drawing into a finished image from your prompt (GPT Image 2.5 Sunburst).

![A pencil sketch of a cottage rendered as a spring photograph](media/before-after/render-sketch-cottage.jpg)

**New angle** (More > Make variants): Turn left 45°, Turn right 45°, Side view, Back view or From above. No prompt.

![A tin robot seen from the front, then turned 45 degrees](media/before-after/new-angle-robot.jpg)

**Split into layers**: rebuilds the image as a group: a clean background and one layer per element, each placed where it was.

![A desk flat-lay, its clean background plate, and the plant, mug and laptop on their own layers](media/before-after/split-into-layers-desk.jpg)

**Remove text** (More > Finish): the same image without its text, as a new layer above. **Split text** (More > Layers) gives the clean base and the text on its own layer instead.

![A jazz poster with and without its text](media/before-after/remove-text-poster.jpg)

**Formats**: reframes the image to Story 9:16, Feed 4:5, Square 1:1 or Wide 16:9 (Scenario Smart Reframe), as an artboard in a new "<title> formats" document.

![A landscape street scene with a red bicycle, reframed to 9:16](media/before-after/formats-bicycle.jpg)

**Animate** (More > Animate): a short clip from the image and your prompt (Minimax H3 Fast, 5 s by default). The clip opens as a new document and the MP4 is saved in the output folder. **Frame to layer** brings its last frame back as a layer.

![A cup of tea by a rainy window, animated: steam rises and rain runs down the glass](media/video/animate-tea.gif)

*The clip as Scenario returned it. [MP4](media/video/animate-tea.mp4).*

**Relight to scene** (More > Make variants): relights a cut-out or split element to match the visible image. *Verified live* on 0.6.2; no picture in this guide.

**Extend canvas** (More > Finish): grows the canvas to a ratio and fills the new area. In this build the result can show seams where the original meets the new area; see [Known limitations](KNOWN_LIMITATIONS.md).

**Place from Library** (More > Layers): see [Library](#library).

## Selection edits: Inside selection or Bolder

Replace inside has an **Edit** chip with two modes, each with its price:

<img src="media/screens/edit-inside-or-bolder.png" width="320" alt="The Edit menu: Inside selection and Bolder, each with a description and a price">

- **Inside selection** (Ideogram 4.5 Precise Edit): changes only what is inside the selection; everything outside stays as it is. Good for a change that fits the shape you drew.
- **Bolder** (GPT Image 2.5 Flare): a stronger change. The new subject may reach past the selection, and the layer mask grows to keep it whole. Good when the new object is taller or wider than the old one, as with the glass of lemonade above.

<img src="media/screens/selection-replace-priced.png" width="260" alt="Replace inside with Edit Inside selection, Ideogram 4.5 Precise Edit, 12 CU"> <img src="media/screens/selection-bolder-priced.png" width="260" alt="Replace inside with Edit Bolder, GPT Image 2.5 Flare, 4 CU">

After a run, the take offers **Try Bolder** or **Try Inside selection** to run the other mode.

<img src="media/screens/selection-edit-landed.png" width="320" alt="The Bolder take of the lemonade glass in Recent, with its May not line up badge, Refine and More like this">

*The Bolder take above carries **May not line up**: the glass reaches past the selection, as Bolder allows.*

Tips:

- A feathered selection blends the edge. Leave some margin around the object.
- With Inside selection, an object taller than the selection is cut at its edge: draw the selection to the size of the new object, or use Bolder.
- A take can carry a check badge: **Edges ok**, **May not line up**, **Part unchanged** or **Spills past**. The checks look at tone and alignment around the edge; they do not catch every visible patch, so look at the result.

![Replace inside with Bolder, from selection to result](media/video/selection-edit.gif)

*[MP4](media/video/selection-edit.mp4).*

## Takes

When an action makes several takes, they land as a group with take 1 visible, and the Takes card shows one tile per take. A single take lands as a layer with the same card.

<img src="media/screens/takes-landed.png" width="320" alt="One take of a lighthouse placed as a layer: Compare takes, More like this, Refine, Upscale kept take">

<img src="media/screens/takes-compare.png" width="320" alt="The Takes card with two takes of a green sneaker, Keep take 1, Refine and More like this">

- Click a tile to show that take in the document (one History state).
- **Keep take N** removes the other takes from the document; their files stay in the output folder and in Jobs.
- **Refine** keeps the shown take, loads its selection back and opens Replace inside on it.
- **More like this** runs again with the shown take as a reference.
- **Upscale kept take** upscales the take you kept.

Select the group in the Layers panel later, even after a restart, and the card comes back from the layers' metadata. *Verified live*.

## References

**+ Reference** adds an image the model uses as a reference: the selection's box, the active layer, all visible, a PNG or JPEG file, or a Library image. The hint next to it reads "Selection, layer or file". Layers pinned as document references (Character, Set, Style, Product) are kept in the document and come back with the file. References upload when you click the action button. *Verified live* (a layer reference on Replace inside, a Library reference).

On Replace inside, a reference of a whole scene may be copied into the selection: use an object or a style as the reference. The panel says so under the references row. *Tested automated*; seen live on 0.7.0, when a reference of the same scene was redrawn into the selection box.

## Style and trained models

The **Style** chip offers **No style** (the model's own look), **Match an image** (a picture goes as the style reference, with any model that takes references) and the project's trained styles.

<img src="media/screens/style-menu.png" width="320" alt="The Style menu: No style and Match an image">

The **Model** chip lists the recommended model for the action and up to eight catalog models that can do it, with their prices for this document as the price checks come back (some rows can stay without a price), then **All models…**.

<img src="media/screens/model-menu.png" width="320" alt="The Model menu: the recommended model, catalog models with prices, and All models">

**All models…** opens the picker: search, the Image, Edit, Enhance and Trained tabs, filters (All, Favorites, Recommended, References), and a star to keep favorites.

<img src="media/screens/model-picker.png" width="320" alt="The model picker with search, tabs, filters and the model list">

**Trained models.** **Run with** a trained model, the project's or a public one, runs it on its base model for the selected action, with its trigger words before your prompt. A trained style runs on the model it was trained on, and a style and a model stack on one base when it takes both. *Verified live* (M7): Run with, Make new and a selection edit with FLUX.1 Dev and FLUX.2 Dev trained models. *Not tested* live: the Z-Image route and a stacked run.

## Library

**Place from Library** (More > Layers) opens a grid of the project's images with a search field and the filters All, Generated, Edited and Uploaded, then **Show more**. Click an image to place it as a new layer at its own size, never enlarged, centered, in one History state. **+ Reference > Library** uses the same grid. *Verified live*.

<img src="media/screens/library-placed.png" width="320" alt="After placing a Library image: the note at the bottom says it is placed as a new layer">

Dragging from the grid is not in this build.

## Prices and approval

- The price is checked for free (a dry run, which creates no job) about half a second after each change, and shows on the button: exact (`12 CU`, `Free`), a range, or `from N CU`.
- An action that needs a prompt reads **Fill in the prompt to see the price** until it has one.
- **A click on a priced button is the approval.** Above 100 CU, for the top of a range and for any `from` price, a card asks first.
- The request is built again at the click. If the document, the selection or a setting changed since the price check, nothing is sent.
- If the price changes once references or captures are uploaded, the panel stops and asks again. Nothing was spent. *Verified live* (New angle: 1 CU before the upload, 6 CU after).

  <img src="media/screens/price-changed-approval.png" width="320" alt="Price changed after upload. Now 6 CU (was 1 CU). Nothing was spent. Cancel or Approve 6 CU">

- A failed job shows "Refunded by Scenario"; a model without refunds says so before you click.
- A CU limit on your key caps what the plugin and agents can spend.

## Jobs and recovery

**Jobs** in the header opens the six newest jobs on this computer; **All jobs** opens the full list with each job's status, price words ("quoted 6, charged 6 CU") and its actions. *Verified live*.

<img src="media/screens/jobs-popover.png" width="320" alt="The Jobs popover with the latest jobs, their time and price">

<img src="media/screens/jobs-view.png" width="320" alt="The Jobs view: each job with its picture, status, price and Open as document">

- Each job is written to disk before anything is sent, so Jobs survives a restart of Photoshop. *Verified live* (M5, six restart points).
- After a restart: a job that was uploading or waiting for approval becomes not sent (nothing charged); generating jobs resume; finished ones download again; nothing lands in a document by itself.
- A job whose request may or may not have reached Scenario (no answer, lost connection) is **Unknown**. The plugin looks it up on Scenario: **Link** continues a match; **Mark not sent** appears only when a complete look-up found none. The same request is blocked until then, so nothing is paid twice.
- **Place**, **Place in current document** and **Open as document** land a finished result where you choose. A result goes back to the document it started from, while that document is open and in front.
- Downloads can be stopped and resumed.

## Settings

Open **Settings** from the panel menu.

- **Account**: the signed-in project, **Add a key for another project**, **Test connection**, **Sign out** (removes the key from this computer; delete it on app.scenario.com to revoke it).
- **Connect an AI agent**: link status, the pairing token, the three agent switches, No-spend mode, agent spending, **Connect a client** and the activity log. See [Agents](#agents).

<img src="media/screens/settings-agents.png" width="320" alt="Settings: Connect an AI agent, pairing token, agent switches, No-spend mode and agent spending">

The panel menu also has Projects, Diagnostics, Help, About and Sign Out.

## Agents

An agent such as Claude Code can work in this Photoshop through the plugin's local Scenario MCP server. Every credit it spends goes through a card in the panel, and with **Agents may modify the document** off, every result it wants to land waits on a proposal card.

![Claude Code creates a poster image; the spend card and the proposal card are approved in the panel](media/video/agent-scenario-mcp.gif)

*Claude Code 2.1.304, headless, through the helper over stdio. The cards were approved with clicks in the panel. [MP4](media/video/agent-scenario-mcp.mp4).*

Setup, switches, approvals and the tool list: [MCP.md](MCP.md).

## Where results are saved

Every result is saved before it is placed, kept or not, in the plugin's output folder:

`~/Library/Application Support/Adobe/UXP/PluginsStorage/PHSP/27/External/com.scenario.photoshop/PluginData/Scenario/<kind>/<date>/`

Results are also in your Scenario project, so you find them again in the Library and on app.scenario.com. Each placed layer carries Scenario metadata (model, prompt, settings, job, prices) in its XMP, which survives saving the PSD.

## Troubleshooting

| What you see | What to do |
|---|---|
| The panel is empty on Photoshop's Home screen | Open or create a document. Photoshop hides docked panels on Home |
| "Scenario did not accept this key and secret." | Check you copied both, from a Project key. **Enter key again** or **Create an API key** |
| "API keys need a Starter plan or above. This team's plan has no API access." | Use a team on a plan with API access, or **Open plans**. **Copy a request for your admin** prepares the message |
| A Team (Organization) key or a Reader key | Use a Project key with the Editor role |
| **Fill in the prompt to see the price** | The action needs a prompt |
| A card says the price changed | Nothing was spent. **Approve** at the new price or **Cancel** |
| A job is **Unknown** | Open Jobs and let it look the job up; **Link** or **Mark not sent** |
| A result did not land | Bring the document it started from to the front, then **Place** in Jobs, or **Open as document** |
| "No connection to Scenario. Check your network." | Check the network, then **Retry**. A job that was being sent when the connection dropped shows as **Unknown** in Jobs until it is looked up |
| An agent says `NotConnected` | Open the Scenario panel; the helper reaches it only while it is open |

<img src="media/screens/error-key-refused.png" width="300" alt="Sign-in error: Scenario did not accept this key and secret, with Enter key again and Create an API key"> <img src="media/screens/error-no-api-access.png" width="300" alt="Sign-in error: API keys need a Starter plan or above, with Open plans and Copy a request for your admin">

*Drawn from the panel's own failure copy; the errors themselves were not produced live in this pass.*

**Copy diagnostics** (Settings, or **Diagnostics…** in the panel menu) shows a short report before it copies it, for a bug report: versions, switch states, job counts and the last error types, with no prompts, names, ids, paths, keys or tokens. *Tested automated*. See [SECURITY.md](../SECURITY.md) for security issues.

## Not in this build

- Start a set, Same action on each, and Run a workflow.
- Drag and drop onto the panel or from the Library grid.
- Windows: built for it, *not tested*.
- Photoshop versions before 27.11: *not tested*.

The full list: [Known limitations](KNOWN_LIMITATIONS.md).
