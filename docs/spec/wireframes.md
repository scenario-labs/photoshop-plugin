# Wireframes (spec v1)

Status: draft for review, revision 3, 2026-10-19. Companion to [SPEC.md](SPEC.md), section 3. Section numbers here follow the screen list in SPEC 3.15.

- Frames are drawn at the default docked width, 320 px, as 40 columns of 8 px. Section 2 also draws the 280 px minimum (35 columns); below 320 px the lane tabs show icons with tooltips.
- `[ Label ]` is a button, `[v]` a dropdown, `( )` and `(o)` radio buttons, `[ ]` and `[x]` checkboxes, `(Chip)` a filter chip, `[th]` a thumbnail, `>` a collapsed row, `v` an expanded row.
- CU figures are placeholders (`N CU`, `M CU`). Model names are placeholders: the plugin shows names and descriptions from the Scenario catalog. Project names, file names and key endings are invented examples.
- UXP has no CSS transitions, so state changes are immediate; every progress bar carries text. Cards and notices are inline banners in the panel's flow, never overlays near a text field. Only the spend confirmation is a modal dialog.

## 1. First run and sign-in

Shown when no key is saved. **Create an API key** opens the API keys page on app.scenario.com; Photoshop asks for consent on that click. Pasting `key:secret`, or two lines, into the key field moves the secret to the masked field at once.

```
+--------------------------------------+
| [S] Scenario                         |
+--------------------------------------+
| Connect your Scenario account        |
| Generative AI by Scenario.           |
|                                      |
| Needs a Scenario plan with API       |
| access (Starter or above).           |
|                                      |
| 1. Create a Project key with the     |
|    Editor role, in the project you   |
|    want to use.                      |
|    [ Create an API key ]             |
|    Only team admins and project      |
|    owners can create keys.           |
|    [ Copy a request for your admin ] |
|    No account, or no plan with API   |
|    access? [ See plans ]             |
|    [ Create a Scenario account ]     |
| 2. Paste the key and its secret.     |
|                                      |
| API key                              |
| [ Paste key, or key:secret        ]  |
| API secret                           |
| [ ******************************* ]  |
|                                      |
| [ Save and test                   ]  |
|                                      |
| Keys stay in Photoshop's secure      |
| storage on this computer.            |
| How sign-in works  |  Privacy        |
+--------------------------------------+
```

**Save and test** makes two free calls: an authenticated read, then a price check of the default model. Whether Scenario refuses that price check for a key that cannot run models is measured in M2.0; if it does not, "This key can't run models" appears at the first Generate instead, with nothing spent. Its states:

```
+--------------------------------------+
| [ Save and test ]   Testing 1 of 2   |
+--------------------------------------+
| x Scenario did not accept this key   |
|   and secret.                        |
|   [ Enter key again ]                |
|   [ Create an API key ]              |
+--------------------------------------+
| x API keys need a Starter plan or    |
|   above. This team's plan has no     |
|   API access.     [ Open plans ]     |
+--------------------------------------+
| x This key can't run models. Create  |
|   a Project key with the Editor or   |
|   Admin role.                        |
|   [ Create an API key ]              |
|   [ Copy error ]                     |
+--------------------------------------+
| x This is a team (Organization) key. |
|   Generating needs a Project key.    |
|   [ Create an API key ]              |
+--------------------------------------+
| x No connection to Scenario.         |
|   Check your network.  [ Retry ]     |
+--------------------------------------+
| Connected to Scenario                |
| Project: Fall campaign               |
| Key ....7KQ2                         |
+--------------------------------------+
| Connected to Scenario                |
| Project: Scenario project ....7KQ2   |
| (the API returned no project name)   |
+--------------------------------------+
```

After **Copy a request for your admin**:

```
+--------------------------------------+
| Copied. Send it to your Scenario     |
| admin, then paste the key and secret |
| they give you here.                  |
+--------------------------------------+
```

Then the ready banner, above the Image lane. It does not block anything and goes away at the first Generate or on its close button. The Image prompt holds a sample prompt, selected, so a click on Generate is the first generation:

```
+--------------------------------------+
| Ready. Describe a new image below,   |
| or select an area and use Edit to    |
| change it.                       [x] |
+--------------------------------------+
```

## 2. Main view

Header, lane tabs, lane body (scrolls), results tray (collapses to one line), prompt bar (fixed). The project name opens the Projects view. The dot before **Jobs** is the agent connection: `o` when no agent is connected, `*` when one is. The Image lane with a selection active:

```
+--------------------------------------+
| [S] Fall campaign v  * Jobs 2    [=] |
+--------------------------------------+
| [Image] Edit Enhance Trained Library |
+--------------------------------------+
| Target  Selection 928 x 928     [v]  |
|         lands masked to selection    |
| Makes a new picture, masked to the   |
| selection. To change what is inside  |
| it, use Edit.                        |
|                                      |
| Model                                |
| +------+ Model name                  |
| | [th] | Catalog description, two    |
| |      | lines at most.              |
| +------+ Refs up to 4  [ Change ]    |
|                                      |
| References (2 of 4)                  |
| [th] [th] [ + Add ]                  |
| > Advanced (6 settings)              |
+--------------------------------------+
| v Latest: 4 takes, placed            |
| [t1*] [t2] [t3] [t4]                 |
| Seam ok                              |
| [ Keep this take ]                   |
| [ Reuse settings ] [ More v ]        |
+--------------------------------------+
| Describe the image...                |
|                                      |
| Takes [1 v]   Size [3:2 v]           |
| [ Generate (N CU)                 ]  |
+--------------------------------------+
```

**+ Add** on references opens a menu: Selection, Current layer, All visible, From Library, File. A reference is captured when added and uploaded when Generate is clicked.

The Image lane with no document open. The result opens as a new document at the Size preset:

```
+--------------------------------------+
| [S] Fall campaign v  o Jobs      [=] |
+--------------------------------------+
| [Image] Edit Enhance Trained Library |
+--------------------------------------+
| Target  New document 1024 x 1024     |
|         No document is open.         |
|                                      |
| Model   Model name       [ Change ]  |
| > Advanced (6 settings)              |
+--------------------------------------+
| A lighthouse on a cliff at sunrise,  |
| painterly                            |
| Takes [1 v]   Size [1:1 v]           |
| [ Generate (N CU)                 ]  |
+--------------------------------------+
```

Edit and Enhance with no document open:

```
+--------------------------------------+
| Image [Edit] Enhance Trained Library |
+--------------------------------------+
| Open or create a document to use     |
| this lane.                           |
|                   [ New document ]   |
+--------------------------------------+
```

At the 280 px minimum width. Lane tabs show icons (drawn here as two letters) with tooltips, the tray is collapsed to one line, and the lane body keeps at least 120 px:

```
+---------------------------------+
| [S] Fall cam... v * Jobs 2  [=] |
+---------------------------------+
| [Im]  Ed   En   Tr   Li         |
+---------------------------------+
| Target Selection 928 x 928  [v] |
|                                 |
| Model  Model name  [ Change ]   |
| References (2 of 4)             |
| [th] [th] [ + ]                 |
| > Advanced (6)                  |
+---------------------------------+
| > Latest: 4 takes, placed       |
+---------------------------------+
| Describe the image...           |
| Takes [1 v]  Size [3:2 v]       |
| [ Generate (N CU)            ]  |
+---------------------------------+
```

The Projects view, from the project name in the header:

```
+--------------------------------------+
| < Projects                           |
+--------------------------------------+
| (o) Fall campaign          ....7KQ2  |
| ( ) Mascot training        ....A1C9  |
|                                      |
| [ Add a key for another project ]    |
|                                      |
| Switching changes trained models,    |
| the Library and where results go.    |
| Running jobs keep their project.     |
+--------------------------------------+
```

## 3. Enhance lane

A tool selector sits where the model card sits in other lanes. Upscale:

```
+--------------------------------------+
| Image Edit [Enhance] Trained Library |
+--------------------------------------+
| Tool  [Upscale] Expand  Remove BG    |
|                                      |
| Source  All visible 3000 x 2000 [v]  |
| Model   Model name       [ Change ]  |
| Factor  [2x v]   Output 6000 x 4000  |
| Lands   (o) New document             |
|         ( ) Layer in this document   |
| > Advanced (3 settings)              |
+--------------------------------------+
| [ Generate (N CU)                 ]  |
+--------------------------------------+
```

With **Selection box** as the source, **Lands** offers **Layer over the box** (the default, for detail repair) and **New document**.

Expand with a model that takes a mask (the default), so every anchor and Per side work. The anchor sets where the current image sits on the new canvas:

```
+--------------------------------------+
| Image Edit [Enhance] Trained Library |
+--------------------------------------+
| Tool  Upscale [Expand]  Remove BG    |
|                                      |
| Model   Model name       [ Change ]  |
|         Mask input: any anchor       |
| Canvas  (o) Aspect   ( ) Per side    |
| (1:1) [4:5] (3:2) (2:3) (16:9)       |
| (9:16) (Custom)                      |
| Anchor  [ ][ ][ ]                    |
|         [ ][x][ ]                    |
|         [ ][ ][ ]                    |
| Size    3000 x 2000 to 3000 x 3750   |
| Lands   (o) This document            |
|         ( ) A copy of this document  |
| > Advanced (overlap 32 px, 2 more)   |
+--------------------------------------+
| Describe the new area (optional)     |
| [ Generate (N CU)                 ]  |
+--------------------------------------+
```

When the new canvas is larger than the model's maximum output, the warning shows before the spend (SPEC 5.8):

```
+--------------------------------------+
| Size    6000 x 4000 to 6000 x 7500   |
+--------------------------------------+
| ! New area at about 55% of this      |
|   document's resolution: the model   |
|   outputs at most 4096 px. Upscale   |
|   the result if you need more.       |
+--------------------------------------+
| [ Generate (N CU)                 ]  |
+--------------------------------------+
```

A model with an exact output size and no placement setting:

```
+--------------------------------------+
| Model   Model name       [ Change ]  |
|         Exact size, no placement     |
| Canvas  (o) Aspect   Per side (off)  |
| Anchor  center only                  |
|         This model expands around    |
|         the center.                  |
+--------------------------------------+
```

Remove BG on a pixel layer, and on a layer that already has a mask. On the Background layer, **Mask on the layer** first converts it to a normal layer, in the same History state:

```
+--------------------------------------+
| Image Edit [Enhance] Trained Library |
+--------------------------------------+
| Tool  Upscale  Expand  [Remove BG]   |
|                                      |
| Source  Layer "Product shot"    [v]  |
| Model   Model name       [ Change ]  |
| Lands   (o) Mask on the layer        |
|         ( ) New cutout layer         |
+--------------------------------------+
| [ Generate (N CU)                 ]  |
+--------------------------------------+
| Source  Layer "Bottle"          [v]  |
| Lands   New cutout layer             |
|         This layer already has a     |
|         mask; it stays as it is.     |
+--------------------------------------+
```

## 4. Model picker

A full panel view (text fields render above overlays in UXP, so the picker cannot float over the form). Tabs and tools come from the mapping in SPEC 3.3. Chips per tab:

| Tab | Chips |
|---|---|
| Image | All, Favorites, Recommended, References, Tags menu |
| Edit | All, Favorites, Recommended, Mask input, References, Tags menu |
| Enhance | All, Favorites, Upscale, Expand, Remove BG, Tags menu |
| Trained | All, Favorites, Tags menu |

```
+--------------------------------------+
| < Models                             |
| [ Search models                   ]  |
| [Image] Edit  Enhance  Trained       |
| (All) (Favorites) (Recommended)      |
| (References)           [ Tags v ]    |
+--------------------------------------+
| [th] * Model name                    |
|        Two-line description from     |
|        the catalog.                  |
|        4 refs . 4096 px              |
+--------------------------------------+
| [th]   Model name      Experimental  |
|        Two-line description from     |
|        the catalog.                  |
|        4 refs . 2048 px              |
+--------------------------------------+
|              [ Load more ]           |
+--------------------------------------+
```

The highlighted row expands:

```
+--------------------------------------+
| [th] * Model name                    |
|        Full description from the     |
|        catalog, on as many lines as  |
|        it takes.                     |
|        Inputs: prompt, up to 4       |
|        references, mask              |
|        Output up to 4096 x 4096      |
|        Price: N to M CU per image    |
|        [ Use this model ]            |
+--------------------------------------+
```

Empty result:

```
+--------------------------------------+
| < Models                             |
| [ Search: neon logo               ]  |
| (Mask input x)                       |
+--------------------------------------+
| No models in this lane match these   |
| filters.                             |
|                [ Clear filters ]     |
+--------------------------------------+
```

## 5. Trained lane

The project's trained models come first, then Scenario's public ones, marked **Public**. Make new with two LoRAs stacked on their base:

```
+--------------------------------------+
| Image Edit Enhance [Trained] Library |
+--------------------------------------+
| Project  Fall campaign               |
| (o) Make new   ( ) Edit Experimental |
|                                      |
| Trained models (2 of 6)              |
| [th] Brand style v3  LoRA            |
|      Style strength [ 0.80 ] 0 to 2  |
|                         [ Remove ]   |
| [th] Ink outline  LoRA . Public      |
|      Style strength [ 0.50 ] 0 to 2  |
|                         [ Remove ]   |
| [ + Add another ]                    |
| Runs on FLUX.2 Dev                   |
|                                      |
| References (1 of 5)                  |
| [th] [ + Add ]                       |
| > Advanced (5 settings)              |
+--------------------------------------+
| Describe the image...                |
| Takes [1 v]   Size [1:1 v]           |
| [ Generate (N CU)                 ]  |
+--------------------------------------+
```

Edit with a LoRA whose base takes the capture as `image` plus `strength`. Two bases can run it, so **Run with** shows; **Change amount** is the base's `strength`, with its default and range from the schema:

```
+--------------------------------------+
| Project  Fall campaign               |
| ( ) Make new   (o) Edit Experimental |
|                                      |
| Source  Selection 600 x 400     [v]  |
| Sample  All visible             [v]  |
| [th] Mascot paint   LoRA             |
|      Style strength [ 0.75 ]         |
| Run with [ Z-Image            v ]    |
| Change amount [ 0.60 ]  0 to 1       |
|   Lower keeps closer to your layer.  |
+--------------------------------------+
| Edits with trained models are        |
| experimental: check the seam badge.  |
+--------------------------------------+
```

An edit LoRA on a base that requires reference images: in Edit the capture is the first reference; in Make new, Generate waits for a reference:

```
+--------------------------------------+
| (o) Make new   ( ) Edit Experimental |
| [th] Product relight  LoRA . Edit    |
|      Runs on Qwen Edit 2511          |
| References: required  [ + Add ]      |
| This model edits an image. Add a     |
| reference, or use Edit.              |
| [ Generate  disabled              ]  |
+--------------------------------------+
```

A trained model whose base can't take the capture, and one this version does not know:

```
+--------------------------------------+
| (o) Make new   ( ) Edit (off)        |
| This model can't edit an area. Use   |
| Make new, then use the result as a   |
| reference in Edit.                   |
+--------------------------------------+
| [th] Old style   (greyed)            |
|      This trained model type isn't   |
|      supported by this version of    |
|      the plugin.                     |
+--------------------------------------+
```

No trained models in this project:

```
+--------------------------------------+
| No trained models in project Fall    |
| campaign yet. Scenario's public      |
| models are listed below; models      |
| trained in other projects appear     |
| when you switch project.             |
| [ Open Scenario ] [ Switch project ] |
+--------------------------------------+
```

## 6. Library lane

Browsing lists the project's images, newest first. Selecting a thumbnail shows its actions:

```
+--------------------------------------+
| Image Edit Enhance Trained [Library] |
+--------------------------------------+
| Project  Fall campaign               |
| Collection [ All images         v ]  |
| [ Search images                   ]  |
| [ ] Show plugin uploads              |
+--------------------------------------+
| [th]       [th]       [th]           |
| [th]       [th*]      [th]           |
| [th]       [th]       [th]           |
|             [ Load more ]            |
+--------------------------------------+
| logo-mark . 2048 x 2048 . Oct 12     |
| [ Place ]  [ Use as reference v ]    |
| [ Open as document ]  [ Details ]    |
+--------------------------------------+
```

The plugin's own uploads (captures, masks, references) are hidden unless **Show plugin uploads** is on. **Use as reference** offers "in Image", "in Edit" and "in Trained". **Place** lands the asset at native size, or contained in the selection box or the canvas when larger, never enlarged. Search that finds nothing:

```
+--------------------------------------+
| [ Search: harbor night            ]  |
+--------------------------------------+
| No images match "harbor night".      |
| Search can miss recent assets.       |
|                 [ Show all ]         |
+--------------------------------------+
| No images in project Fall campaign   |
| yet.                                 |
+--------------------------------------+
| This collection has no images.       |
+--------------------------------------+
```

## 7. Prompt bar

Fixed at the bottom of every generating lane. Cmd+Enter (Ctrl+Enter on Windows) generates when the price is current; Enter adds a line; Up and Down in an empty field recall recent prompts. The button states:

```
+--------------------------------------+
| A coastal town at dusk, warm window  |
| lights, wet cobblestones             |
| Takes [2 v]   Size [3:2 v]           |
+--------------------------------------+
| [ Generate (N CU)                 ]  |
|   exact price, quote valid 120 s     |
+--------------------------------------+
| [ Generate (N to M CU)            ]  |
|   charge depends on outputs returned |
+--------------------------------------+
| [ Generate (from N CU)            ]  |
|   charge can be higher; always       |
|   confirmed                          |
+--------------------------------------+
| [ Sending...                      ]  |
|   disabled while this request is     |
|   sent                               |
+--------------------------------------+
| [ Checking price...               ]  |
+--------------------------------------+
| [ Generate (price after upload)   ]  |
|   this model prices the uploaded     |
|   image; first click uploads it      |
+--------------------------------------+
| [ Confirm (N CU)                  ]  |
|   selection uploaded; price exact    |
+--------------------------------------+
| [ Price unavailable               ]  |
|   Prompt is required by this model.  |
+--------------------------------------+
| [ Generate (12.4K CU)             ]  |
|   K and M from 10,000 CU             |
+--------------------------------------+
```

## 8. Selection edit

The Edit lane with a selection, on a 16-bit document. The source chip follows the selection (coalesced at 200 ms). The context is shaped to the model's size inputs (SPEC 5.8), and the capture counts as the first reference when the model edits its first reference. The capture is recorded when Generate is clicked, so changing the selection afterwards does not change the job:

```
+--------------------------------------+
| [S] Fall campaign v  * Jobs 2    [=] |
+--------------------------------------+
| Image [Edit] Enhance Trained Library |
+--------------------------------------+
| Source  Selection 928 x 928     [v]  |
| Sample  All visible             [v]  |
| Margin  auto (464 px)   Feather 2 px |
| Context 1856 x 1856, shaped to model |
| ! 16-bit document: edits are 8-bit   |
|   sRGB inside the selection.         |
|                                      |
| Model   Model name       [ Change ]  |
|         Mask input                   |
| References  Capture + 1 of 10        |
| [cap] [th] [ + Add ]                 |
| > Advanced (5 settings)              |
+--------------------------------------+
| Replace the sky with dusk clouds     |
|                                      |
| Takes [2 v]                          |
| [ Generate (N CU)                 ]  |
+--------------------------------------+
```

Without a selection:

```
+--------------------------------------+
| Source  Layer "Background copy" [v]  |
|         No selection: edits the      |
|         whole layer, lands unmasked. |
+--------------------------------------+
```

While the job runs, the panel stays usable and the person can keep working in the document:

```
+--------------------------------------+
| Edit "dusk-sky"                      |
| Uploading selection        [====  ]  |
+--------------------------------------+
| Edit "dusk-sky"                      |
| Generating 1 of 2          [==    ]  |
|                           [ Cancel ] |
+--------------------------------------+
| Edit "dusk-sky"                      |
| Downloading 2 of 2         [===== ]  |
+--------------------------------------+
```

Results landed as a group with take 1 visible and the mask on the group. Clicking a thumbnail shows that take. The selection is left as it was. **More** offers Upscale, Remove BG, Expand, Use as reference and Open as document with this take as the source:

```
+--------------------------------------+
| v Latest: 2 takes, placed            |
| [t1*] [t2]                           |
| t1  Seam ok                          |
| t2  Edge tone differs                |
| [ Keep this take ]  [ Details ]      |
| [ Reuse settings ]  [ More v ]       |
+--------------------------------------+
| Placed as "Scenario edit dusk-sky    |
| (2 takes)" above Sky, masked to the  |
| selection. Ctrl+Z undoes it in one   |
| step.                                |
+--------------------------------------+
```

A job whose document is open but not active waits in the tray:

```
+--------------------------------------+
| Ready for poster.psd: 2 takes        |
| [t1] [t2]                            |
| [ Place ]  [ Open as document ]      |
+--------------------------------------+
```

After the first placed result, once:

```
+--------------------------------------+
| Prompts and prices are saved in      |
| layer metadata and travel with the   |
| PSD. Settings > Results can leave    |
| them out.                            |
| Agents can work here too:            |
| [ Connect a client ]        [ OK ]   |
+--------------------------------------+
```

Special cases:

```
+--------------------------------------+
| ! Quick Mask is on.                  |
|   [ Use Quick Mask as selection ]    |
+--------------------------------------+
| ! Layer "Sky" is hidden. Show it to  |
|   use it as the source.              |
|   [ Show layer ]                     |
+--------------------------------------+
| ! Selection is too small to edit.    |
+--------------------------------------+
| ! The canvas changed since this edit |
|   started.                           |
|   [ Place unmasked ]                 |
|   [ Open as document ]               |
+--------------------------------------+
| ! Unchanged inside: the model may    |
|   have read the mask inverted.       |
|   [ Details ]                        |
+--------------------------------------+
| ! Pixels outside the selection       |
|   changed.                [ Undo ]   |
+--------------------------------------+
| ! May be misaligned: the result's    |
|   shape differs; placed inside the   |
|   box.                               |
+--------------------------------------+
| ! Input reduced to N px to fit the   |
|   upload limit.                      |
+--------------------------------------+
```

## 9. Details

From a tray card, a Jobs row, the header menu or the chip that appears when the active layer carries Scenario metadata:

```
+--------------------------------------+
| Image [Edit] Enhance Trained Library |
+--------------------------------------+
| Scenario layer: edit dusk-sky        |
|                        [ Details ]   |
+--------------------------------------+
```

```
+--------------------------------------+
| [S] Fall campaign v  * Jobs 2    [=] |
|                 +------------------+ |
|                 | Settings         | |
|                 | Details of       | |
|                 |  selected layer  | |
|                 | Help             | |
|                 | Report a problem | |
|                 +------------------+ |
+--------------------------------------+
```

```
+--------------------------------------+
| < Details                            |
| Scenario edit dusk-sky a1b2c3        |
+--------------------------------------+
| Model     Model name                 |
| Trained   none                       |
| Prompt    Replace the sky with dusk  |
|           clouds                     |
| Settings  2 takes, 1024 x 1024       |
|           > All settings             |
| Inputs    [ctx] [mask]               |
| Price     quoted N, charged N CU     |
| Created   2026-10-19 14:02           |
| Origin    You                        |
| Checks    Seam ok, outside unchanged |
| Ids       job ....9c1e, asset a1b2c3 |
| Plugin    0.1.0                      |
+--------------------------------------+
| [ Reuse settings ] [ Select layer ]  |
| [ Copy ids ]                         |
+--------------------------------------+
```

When the document left prompts or prices out, those rows read "left out of this document". For a layer without Scenario metadata: "The selected layer has no Scenario metadata."

## 10. Approvals

The person's click on a priced button is the approval. Above the confirm limit (Settings > Spending, default 100 CU, compared with M for a range), and for every `from` price, a modal dialog:

```
+--------------------------------------+
| Confirm spend                        |
+--------------------------------------+
| This generation costs up to N CU,    |
| above your confirm limit of 100 CU.  |
|                                      |
| Model name . 4 takes . 4096 x 4096   |
|                                      |
| [ Cancel ]      [ Generate (N CU) ]  |
+--------------------------------------+
```

For a `from` price, whatever the limit:

```
+--------------------------------------+
| Confirm spend                        |
+--------------------------------------+
| This generation costs from N CU.     |
| The charge can be higher; Scenario   |
| gives no upper bound for this model. |
|                                      |
| [ Cancel ] [ Generate (from N CU) ]  |
+--------------------------------------+
```

When the exact price after upload differs from the price shown on the button:

```
+--------------------------------------+
| Price changed after upload.          |
| Now N CU (was M CU). Nothing was     |
| spent.                               |
| [ Cancel ]      [ Generate (N CU) ]  |
+--------------------------------------+
```

An agent's first upload from a document (or a chosen file) in its session:

```
+--------------------------------------+
| ! Allow Claude Code to send pixels   |
|   from poster.psd to Scenario for    |
|   this session?                      |
+--------------------------------------+
| First upload: selection 928 x 928    |
| [ctx] [mask]                         |
| Later uploads from this document by  |
| this client are listed in the        |
| activity log.                        |
| [ Deny ]                  [ Allow ]  |
+--------------------------------------+
```

An agent asks to spend, with Agent spending set to **Ask each time** (the default). The card sits at the top of the panel and in Jobs:

```
+--------------------------------------+
| ! Claude Code asks to spend N CU     |
+--------------------------------------+
| Edit . Model name . 2 takes          |
| "Replace the sky with dusk clouds"   |
| Inputs  [ctx] [mask]                 |
| Target  poster.psd, above Sky        |
| Client name as reported by the       |
| client.                              |
| [ Decline ]     [ Approve (N CU) ]   |
+--------------------------------------+
```

The card and its button state the price kind: "asks to spend N to M CU" with **Approve (up to M CU)**, or "asks to spend from N CU, no upper bound" with **Approve (from N CU)**. A `from` price shows this card even under an allowance.

The person gives an allowance in Settings > Agents (section 13). While it runs, the header shows what is left, and **End** stops it:

```
+--------------------------------------+
| [S] Fall campaign v  * Jobs 2    [=] |
| Agent allowance: Claude Code,        |
| 180 of 300 CU left          [ End ]  |
+--------------------------------------+
```

A charge above its quote ends the allowance:

```
+--------------------------------------+
| ! Allowance ended: Claude Code was   |
|   charged N CU, above the quoted M.  |
|   [ Settings ]                       |
+--------------------------------------+
```

## 11. Jobs

Opened from **Jobs** in the header. **On this computer** is the ledger:

```
+--------------------------------------+
| < Jobs                               |
| [On this computer]  On Scenario      |
| (All) (Needs attention 1) (Agents)   |
| (This document: N CU charged)        |
+--------------------------------------+
| [th] Edit "dusk-sky"     generating  |
|      You . quoted N CU . 14:02       |
|      [====     ] 1 of 2  [ Cancel ]  |
+--------------------------------------+
| [!]  Image "skyline"                 |
|      awaiting approval               |
|      Codex . N CU . 13:58            |
|      [ Decline ] [ Approve (N CU) ]  |
+--------------------------------------+
| [th] Image "forest-plate"    placed  |
|      Claude Code . N / N CU . 13:40  |
|      [ Select layer ] [ Details ]    |
|      [ Reuse settings ]              |
+--------------------------------------+
| [!]  Upscale "poster"       Unknown  |
|      You . quoted N CU . 13:12       |
|      [ Resolve ]                     |
+--------------------------------------+
| [th] Expand "banner"                 |
|      downloading results 2 of 4      |
|      [ Stop download ]               |
+--------------------------------------+
| [x]  Image "logo"            Failed  |
|      Refunded by Scenario            |
|      [ Copy error ]                  |
|      [ Edit and retry ]              |
+--------------------------------------+
```

A failed job whose record carries `disableRefund` reads "Charged N CU, no refund on failure" instead; only then does it count in the "This document" total.

Resolving an Unknown job. Only the person can do this; agents get `UncertainNeedsPerson`:

```
+--------------------------------------+
| < Resolve unknown job                |
+--------------------------------------+
| The request may or may not have      |
| reached Scenario. Nothing is         |
| retried until you decide.            |
|                                      |
| Sent 13:12 . Model name . N CU       |
| Jobs on Scenario around that time:   |
| (o) 13:12:41  same inputs     [th]   |
| ( ) 13:31:05  other inputs    [th]   |
|                                      |
| [ Link this job ] [ Mark not sent ]  |
| [ Check again ]                      |
+--------------------------------------+
```

**On Scenario** lists the current project's recent jobs, including ones made elsewhere. Nothing here spends:

```
+--------------------------------------+
| < Jobs                               |
| On this computer  [On Scenario]      |
| Fall campaign . newest first         |
+--------------------------------------+
| [th] "harbor at night" . 12:01       |
|      Model name . success            |
|      [ Place ] [ Open as document ]  |
|      [ Use as reference ]            |
|      [ Add to this computer ]        |
+--------------------------------------+
| [th] 11:40 . success                 |
|      [ Place ] [ Open as document ]  |
+--------------------------------------+
|              [ Load more ]           |
+--------------------------------------+
```

Empty ledger:

```
+--------------------------------------+
| Jobs you start here or from an agent |
| appear here. Jobs from another       |
| Photoshop version are on the On      |
| Scenario tab.    [ On Scenario ]     |
+--------------------------------------+
```

## 12. Errors and empty states

Each message names what happened and the next action. The full list is SPEC 3.13. Under every error, **Report a problem** opens the repository's issue form with nothing attached.

Account and limits:

```
+--------------------------------------+
| Scenario refused this request:       |
| <Scenario's message>. The key may    |
| not have access to this model or     |
| action.            [ Copy error ]    |
+--------------------------------------+
| This key's or this plan's CU limit   |
| is reached. Nothing was sent.        |
| [ Open plans ]     [ Copy error ]    |
+--------------------------------------+
| Not enough CU for this job.          |
|                   [ Open plans ]     |
+--------------------------------------+
| Not sent: Scenario asked to wait     |
| 30 s.       [ Try again ] (in 30 s)  |
+--------------------------------------+
| Scenario is busy. Retrying in 5 s.   |
+--------------------------------------+
| No-spend mode is on.  [ Settings ]   |
| Prices still show; Generate is off.  |
+--------------------------------------+
| This model is no longer available    |
| to this key.                         |
|            [ Choose another model ]  |
+--------------------------------------+
```

Connection, documents and jobs:

```
+--------------------------------------+
| Offline. Price checks paused; jobs   |
| resume when the connection returns.  |
|                        [ Retry ]     |
+--------------------------------------+
| This lane can't read this document's |
| color mode.                          |
|                 [ Make RGB copy ]    |
+--------------------------------------+
| 32-bit documents are not supported   |
| yet. Convert a copy to 16-bit.       |
+--------------------------------------+
| Photoshop is busy. Placing when it   |
| is free.                             |
+--------------------------------------+
| Download stopped after 3 attempts.   |
|                 [ Resume download ]  |
+--------------------------------------+
| This result is no longer available   |
| on Scenario.         [ Details ]     |
+--------------------------------------+
| Scenario blocked this request        |
| (content policy).    [ Details ]     |
+--------------------------------------+
| <Scenario's failure text>            |
| Refunded by Scenario.                |
| [ Copy error ] [ Edit and retry ]    |
+--------------------------------------+
| Stored on a host this plugin can't   |
| reach.         [ Open on Scenario ]  |
+--------------------------------------+
```

Agent connection:

```
+--------------------------------------+
| Agent connection unavailable:        |
| another program uses port 9890.      |
|               [ Copy diagnostics ]   |
+--------------------------------------+
| The program on port 9890 is not the  |
| Scenario helper.                     |
|               [ Copy diagnostics ]   |
+--------------------------------------+
| A client tried to connect with an    |
| old pairing token. Copy its setup    |
| again.       [ Connect a client ]    |
+--------------------------------------+
```

Empty and loading:

```
+--------------------------------------+
| Models could not load.  [ Retry ]    |
+--------------------------------------+
| Loading models...                    |
| [th] ======================          |
|      ===============                 |
| [th] ======================          |
|      ===============                 |
+--------------------------------------+
```

## 13. Settings

```
+--------------------------------------+
| < Settings                           |
+--------------------------------------+
| Account                              |
| (o) Fall campaign          ....7KQ2  |
| ( ) Mascot training        ....A1C9  |
| [ Add a key for another project ]    |
| [ Test connection ]  [ Sign out ]    |
| Sign out removes the key from this   |
| computer. Delete it on               |
| app.scenario.com to revoke it.       |
+--------------------------------------+
| Spending                             |
| Confirm above [ 100 ] CU             |
| [ ] No-spend mode                    |
|     Refuses paid calls and agent     |
|     uploads.                         |
| A key can carry its own CU cap, set  |
| on app.scenario.com.                 |
+--------------------------------------+
| Results                              |
| Output Folder: plugin folder         |
| [ Choose Output Folder ]             |
| Choose a folder to keep a copy of    |
| job records that survives Photoshop  |
| upgrades.                            |
| [x] Place when ready                 |
| [ ] Leave prompts out of documents   |
| [ ] Leave prices out of documents    |
| Mask feather [ 2 ] px                |
+--------------------------------------+
| > Agents                             |
| > Updates                            |
| > Diagnostics                        |
| > About                              |
+--------------------------------------+
```

Diagnostics and About. **Copy diagnostics** shows the text before copying:

```
+--------------------------------------+
| Diagnostics                          |
| [ Run self-test ]  free              |
| [ Copy diagnostics ]                 |
+--------------------------------------+
| This text will be copied. It holds   |
| no prompts, names, ids, paths, keys  |
| or tokens.                           |
| plugin 0.1.0 . helper 0.1.0          |
| Photoshop 27.11.0 . macOS X.Y        |
| switches: modify off, commands off   |
| jobs: applied 12, failed 1,          |
| uncertain 0                          |
| last errors: RateLimited, Offline    |
| [ Cancel ]                [ Copy ]   |
+--------------------------------------+
| About                                |
| Scenario for Photoshop 0.1.0         |
| Generative AI by Scenario            |
| MIT license . Privacy . Scenario     |
| terms . Report a problem             |
+--------------------------------------+
```

Settings > Agents. All three switches are off by default. The second needs the first and turns off when Photoshop quits; the others persist:

```
+--------------------------------------+
| < Settings . Agents                  |
+--------------------------------------+
| Agent connection                     |
| * Connected: Claude Code, Codex      |
+--------------------------------------+
| [ ] Agents may modify the document   |
|     Off: agent changes arrive as     |
|     proposals you apply.             |
|                                      |
| [ ] Agents may run Photoshop         |
|     commands                         |
|     Lets agents run Photoshop        |
|     commands (batchPlay) on open     |
|     documents: layers, selections,   |
|     masks, adjustments, filters and  |
|     transforms. Each call is one     |
|     History step. Commands that      |
|     save, close, export or print,    |
|     play Actions, run scripts, use   |
|     Adobe's generative features or   |
|     change Photoshop's settings are  |
|     always refused. Turn on only for |
|     agents you trust.                |
|     Needs the switch above. Turns    |
|     off when Photoshop quits.        |
|                                      |
| [ ] Agents read the active document  |
|     only                             |
+--------------------------------------+
| Agent spending                       |
| (o) Ask each time                    |
| ( ) Allow without asking for         |
|     [ Claude Code, since 14:02  v ]  |
|     up to [  50 ] CU per call and    |
|     [ 300 ] CU in total, until it    |
|     disconnects, Photoshop quits     |
|     or you end it. Prices with no    |
|     upper bound always ask.          |
+--------------------------------------+
| [ Connect a client ]                 |
| [ Activity log ]                     |
| [ Reset pairing token ]              |
+--------------------------------------+
```

The activity log lists what agents read, sent, spent and changed:

```
+--------------------------------------+
| < Activity log                       |
+--------------------------------------+
| 14:05 Claude Code  read preview      |
|       poster.psd                     |
| 14:05 Claude Code  upload selection  |
|       (allowed for poster.psd)       |
| 14:06 Claude Code  spend N CU        |
|       (approved)                     |
| 14:07 Claude Code  place edit        |
|       (proposal applied)             |
+--------------------------------------+
```

With **Agents may modify the document** off, an agent's apply becomes a proposal card:

```
+--------------------------------------+
| Claude Code proposes a change        |
+--------------------------------------+
| Place "Scenario edit dusk-sky        |
| a1b2c3" above Sky in poster.psd      |
| [ preview ]                          |
| History: Scenario agent: Place edit  |
| Seam ok . outside unchanged          |
| Expires in 10 min                    |
| [ Dismiss ]              [ Apply ]   |
+--------------------------------------+
```

With it on, the header says so, and each agent change shows an inline banner:

```
+--------------------------------------+
| [S] Fall campaign v  * Jobs 2    [=] |
| ! Agents can edit            [ Off ] |
+--------------------------------------+
| Claude Code placed "Scenario image   |
| forest-plate 0f1e2d".      [ Undo ]  |
+--------------------------------------+
```

## 14. Connect a client

Settings > Agents > Connect a client. The plugin cannot write client config files from its sandbox (SPEC 7.4), so each client gets the shortest path that works from the panel. Commands pin the exact helper version. Status comes from the clients the helper reports.

```
+--------------------------------------+
| < Connect a client                   |
| Agents reach Photoshop through the   |
| scenario-photoshop helper 0.1.0,     |
| which runs on this computer.         |
+--------------------------------------+
| Claude Code              Connected   |
| [ Copy command ]                     |
+--------------------------------------+
| Codex                Not connected   |
| [ Copy command ]                     |
+--------------------------------------+
| Cursor               Not connected   |
| [ Add to Cursor ]                    |
+--------------------------------------+
| Claude Desktop       Not connected   |
| [ Get the extension ] [ Copy token ] |
+--------------------------------------+
| Other clients                        |
| [ Copy JSON ]  [ Copy TOML ]         |
| Add it to your user-level config,    |
| not to a project file that may be    |
| committed.                           |
| With Node: [ Copy setup command ]    |
| Skills:    [ Copy skills command ]   |
+--------------------------------------+
| Commands need Node 20 or later; the  |
| Claude Desktop extension does not.   |
| The token grants access to this      |
| plugin's agent link only.            |
| Pairing token ....9F3A  [ Reset ]    |
+--------------------------------------+
```

After **Copy command**. The command passes the token in an environment variable, never as an argument; the helper's setup saves it in a file only your account can read and adds the server to the client without it:

```
+--------------------------------------+
| Copied. Paste it in a terminal, then |
| restart Claude Code. The row turns   |
| to Connected on the first call.      |
| The clipboard is cleared in 60 s.    |
+--------------------------------------+
```

When a client runs an older helper:

```
+--------------------------------------+
| ! Claude Code runs helper 0.1.0;     |
|   this plugin needs 0.2.0.           |
|   [ Copy new command ]               |
+--------------------------------------+
```
