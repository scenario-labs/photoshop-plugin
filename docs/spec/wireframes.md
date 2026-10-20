# Wireframes (spec v1)

Status: draft for review, revision 6, 2026-10-20 (sections 2, 3, 5 to 8 and 10 redrawn for the creation panel, FLOWS v2). Companion to [SPEC.md](SPEC.md), section 3. Section numbers here follow the screen list in SPEC 3.15.

- Frames are drawn at the default docked width, 320 px, as 40 columns of 8 px. Section 2 also draws the 280 px minimum (35 columns), where action chips and composer chips wrap to more rows.
- `[ Label ]` is a button, `[v]` a dropdown, `( )` and `(o)` radio buttons, `[ ]` and `[x]` checkboxes, `(Chip)` a chip, `[th]` a thumbnail, `>` a collapsed row, `v` an expanded row.
- CU figures in sections 2 to 8 are examples from the test fixtures; elsewhere they are placeholders (`N CU`, `M CU`). Model names are the defaults of this build; the plugin shows names and descriptions from the Scenario catalog. Project names, file names and key endings are invented examples.
- UXP has no CSS transitions, so state changes are immediate; every progress bar carries text. Cards are inline in the panel's flow; menus open as popovers inside the panel, above or below their chip. No banners.

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
|    want to use. A CU limit on the    |
|    key caps what this plugin and     |
|    agents can spend.                 |
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
|   [ Copy a request for your admin ]  |
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

After sign-in the creation panel shows directly (section 2): no banner, no sample prompt. With no document open, Create image is selected and its prompt is empty, so the button reads "Fill in the prompt to see the price" until the person types.

## 2. Creation panel

Header, context card and action chips on top; the Takes card and Recent in the middle part, which scrolls; the composer pinned at the bottom (SPEC 3.1). The panel is one flex column whose middle part scrolls: UXP 9.4 has no `position: sticky`, CSS grid or `gap` (measured with the probe plugin). Chips, menus, popovers and the action button are plain elements: `sp-picker` does not show its value and `sp-action-button` with an icon and a label stacks them. Below 600 px of panel height, the top and the middle part scroll as one block above the composer, so the button is always visible; under 300 px of width the Model chip cuts the model name at 100 px with an ellipsis.

The header is one row of 36 px that never wraps: the Scenario mark (monochrome), the project name with `v` (one line, cut with an ellipsis; the full name is its tooltip; it opens the Projects view), then the agent icon with its dot and the first connected client's name (`o` none, `*` connected, `!` needs the person; a click opens the agent popover) and **Jobs** with the number of jobs on this computer (`Jobs 2`; blue while one runs, amber when one waits for the person). Everything else is in Photoshop's panel menu `[=]`.

`(Chip)` is an action chip, `((Chip))` the selected one; `[v Chip value]` a composer chip with its menu; `[th]` a thumbnail; `[*]` the settings icon.

A layer, no selection (F2). Make versions is selected; its prompt may stay empty. Once the takes land, their group is selected:

```
+--------------------------------------+
| [S] Fall campaign v  * Claude Jobs 2 |
+--------------------------------------+
| +----+ Knight . Layer 1024 x 1536    |
| |[th]| Lands above Knight as a group |
| +----+                               |
| ((Make versions)) (Extend canvas)    |
| (Upscale) (Remove background) (New   |
| layer) (More v)                      |
| ------------------------------------ |
| Takes and recent runs on this        |
| document show here.                  |
+--------------------------------------+
| [Character: Knight] [ + Reference ]  |
| Describe the change, or leave empty  |
| for variations                       |
| [v No style] [v GPT Image 2.5 Flare] |
| [v 4 takes] [v Change: Balanced]     |
| (    Make versions . 5 CU    )   [*] |
+--------------------------------------+
```

The document reference (`Character: Knight`) shows first in the refs row of every action that takes references; a click leaves it out of this run. `+` opens: Selection, Layer, All visible, File..., then **Pin the layer as a document reference** with Character, Set, Style, Product.

No document open (F3). Create image is the one action; the result opens as a new document:

```
+--------------------------------------+
| [S] Fall campaign v  o        Jobs 0 |
+--------------------------------------+
| +----+ No document open              |
| |[ic]| Opens as a new document       |
| +----+ 1536 x 1024                   |
| ((Create image))                     |
|                                      |
+--------------------------------------+
| [ + Reference ]  Selection, layer or |
| file                                 |
| Describe the image                   |
| [v 3:2 1536 x 1024] [v GPT Image 2.5 |
| Flare] [v 4 takes]                   |
| (Fill in the prompt to see the price)|
+--------------------------------------+
```

A selection (F1). The card names the selection and the layer; every selection action is a chip, so there is no More. Cut out subject puts the subject on a new layer, leaves the layer as it is and drops the selection in the same History state, as Layer via Copy does; the new layer is active, so the next frame is the cut-out context:

```
+--------------------------------------+
| +----+ Selection 928 x 640 on Harbor |
| |[sl]| Lands inside the selection,   |
| +----+ masked                        |
| ((Replace inside)) (Remove) (Make    |
| versions) (Cut out subject)          |
+--------------------------------------+
| a red-sailed fishing boat            |
| [v No style] [v GPT Image 2.5 Flare] |
| [v 2 takes]                          |
| (    Replace inside . 3 CU     ) [*] |
+--------------------------------------+
```

A cut-out layer (a mask, or less than the canvas, or a Scenario cut-out): the checkerboard thumbnail, Add background first, the layer as an automatic reference. FLOWS v2 after review adds Relight to scene after Add background; it waits for the relight flow:

```
+--------------------------------------+
| +----+ Bottle . Layer 400 x 600      |
| |::::| Lands below Bottle at canvas  |
| +----+ size                          |
| ((Add background)) (Make versions)   |
| (Upscale) (Extend canvas)            |
| (More v)                             |
+--------------------------------------+
| [ly] [ + ]                           |
| Describe the background              |
| [v No style] [v GPT Image 2.5 Flare] |
| [v 2 takes]                          |
| (    Add background . 7 CU     ) [*] |
+--------------------------------------+
```

More open on a layer. Groups of the actions that run in this build, each with its price; the pin adds one to the chips (at most six):

```
| (Upscale) (Remove background)        |
| (New layer) ((More v))               |
|           +------------------------+ |
|           | FINISH                 | |
|           |   Upscale this 10 CU[p]| |
|           |   layer                | |
|           |   One click, no prompt | |
|           | SELECT AND CUT         | |
|           |   Cut out to a  1 CU[p]| |
|           |   new layer            | |
|           +------------------------+ |
```

A chip menu open (Takes), each count with its price from a free price check; the menu opens above the composer when there is no room below:

```
|           +------------------------+ |
|           | TAKES                  | |
|           |   x1   One result  2 CU| |
|           | v x2   2 results   3 CU| |
|           |        to compare      | |
|           |   x3   ...         4 CU| |
|           +------------------------+ |
| [v GPT Image 2.5 Flare] [v 2 takes]  |
```

The Model menu: **Recommended for <action>** (tagged Recommended), **Catalog . can <action>** (up to eight), then **All models...**, which opens the full list (section 4).

Generating. The context card carries the progress; the panel stays usable:

```
+--------------------------------------+
| +----+ Selection 928 x 640 on Harbor |
| |[sl]| Generating 2 takes            |
| +----+ ==========-------------       |
```

At the 280 px minimum width the chips wrap to more rows and the composer chips to two rows; nothing scrolls sideways:

```
+---------------------------------+
| [S] Fall cam... v  *     Jobs 2 |
+---------------------------------+
| +----+ Selection 928 x 640 on   |
| |[sl]| Harbor                   |
| +----+ Lands inside the         |
|        selection, masked        |
| ((Replace inside)) (Remove)     |
| (Make versions)                 |
| (Cut out subject)               |
+---------------------------------+
| a red-sailed fishing boat       |
| [v No style] [v GPT Image 2.5   |
| Flare] [v 2 takes]              |
| (  Replace inside . 3 CU  ) [*] |
+---------------------------------+
```

The Projects view, from the project name in the header. Rows are list items: a check on the current project, the name (cut with an ellipsis), the key's last characters:

```
+--------------------------------------+
| < Projects                           |
+--------------------------------------+
| v  Fall campaign           ....7KQ2  |
|    Mascot training         ....A1C9  |
|                                      |
| [ Add a key for another project ]    |
|                                      |
| Switching changes trained models,    |
| the Library and where results go.    |
| Running jobs keep their project.     |
+--------------------------------------+
```

## 3. Finishing actions

One click, no prompt (SPEC 3.6). The composer says what the action does instead of a prompt field.

Upscale on a layer (all visible), opening a new document:

```
+--------------------------------------+
| +----+ Knight . Layer 1024 x 1536    |
| |[th]| Opens as a new document       |
| +----+ 2048 x 3072                   |
| (Make versions) (Extend canvas)      |
| ((Upscale)) (Remove background)      |
| (New layer) (More v)                 |
+--------------------------------------+
| (i) Adds detail at the larger size.  |
|     No prompt needed.                |
| [v x2 2048 x 3072] [v Topaz Image    |
| Upscale]                             |
| (       Upscale x2 . 10 CU      )    |
+--------------------------------------+
```

Extend canvas, with the target chip and where the original sits behind `[*]`:

```
| +----+ Harbor . Layer 1024 x 1024    |
| |[th]| Canvas grows to 1824 x 1024,  |
| +----+ new area only                 |
+--------------------------------------+
| Optional: what the new area shows    |
| [v 16:9] [v GPT Image 2.5 Flare]     |
| [v 1 take]                           |
| (     Extend canvas . 2 CU     ) [*] |
+--------------------------------------+
```

A target the canvas already has puts "Already 1:1, pick another target" on the button. Remove background:

```
| +----+ Bottle . Layer 400 x 600      |
| |::::| Lands as a mask on Bottle     |
| +----+                               |
+--------------------------------------+
| (i) Keeps the subject and masks the  |
|     rest. No prompt needed.          |
| [v 851 Labs Background Remover]      |
| (   Remove background . 1 CU   ) [*] |
+--------------------------------------+
```

`[*]` opens **Lands as**: Mask on the layer, or New masked layer (the only choice for a layer that already has a mask, is locked, or is text, shape, adjustment or a group).

## 4. Model picker

**All models...** in the Model chip's menu opens the full list as a panel view (text fields render above overlays in UXP, so a large list cannot float over the composer). Tabs and tools come from the mapping in SPEC 3.3; choosing a base model sets the Model chip of the selected action. Chips per tab:

| Tab | Chips |
|---|---|
| Image | All, Favorites, Recommended, References, Tags menu |
| Edit | All, Favorites, Recommended, Mask input, References, Tags menu |
| Enhance | All, Favorites, Upscale, Expand, Remove BG, Tags menu |
| Trained | All, Favorites, This project, Public, Tags menu |

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

A trained row names its kind and first base:

```
+--------------------------------------+
| [th]   Ink outline         Public    |
|        LoRA via FLUX.2 Dev           |
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
| No models in this tab match these    |
| filters.                             |
|                [ Clear filters ]     |
+--------------------------------------+
```

## 5. Style chip

**Style** (SPEC 3.4): No style, **Match an image** (a picture as the style reference, any model), then on the edit actions (Replace inside, Make versions) a **Trained styles** group with the current project's trained models that can edit. A trained style switches the Model chip to the model it was trained on; on the image and strength route the **Change** chip shows:

```
|           +------------------------+ |
|           | STYLE                  | |
|           | v [st] No style        | |
|           |        The model's own | |
|           |        look            | |
|           |   [im] Match an image >| |
|           |        Style from a    | |
|           |        picture, any    | |
|           |        model           | |
|           | TRAINED STYLES         | |
|           |   [th] Ink & Wash      | |
|           |        Trained style   | |
|           | ---------------------- | |
|           | Trained styles are the | |
|           | project's trained      | |
|           | models and run on the  | |
|           | model they were        | |
|           | trained on. Match an   | |
|           | image uses a picture   | |
|           | as the style           | |
|           | reference, with any    | |
|           | model.                 | |
|           +------------------------+ |
| [v Ink & Wash] [v FLUX.1 Dev]        |
| [v 4 takes] [v Change: Balanced]     |
```

**Match an image** opens its sources (Selection, Layer, All visible, File...). The picture joins the refs row as a **Style** reference with `x`, and the Style chip reads "Match an image":

```
+--------------------------------------+
| [th Style x] [ + ]                   |
| a red-sailed fishing boat            |
| [v Match an image]                   |
| [v GPT Image 2.5 Flare] [v 2 takes]  |
| (    Replace inside . 7 CU     ) [*] |
+--------------------------------------+
```

Under a trained style, the Model menu lists only its base:

```
|           +------------------------+ |
|           | TRAINED STYLE BASE     | |
|           | v [th] FLUX.1 Dev  N CU| |
|           |   Ink & Wash is        | |
|           |   trained on it        | |
|           | ---------------------- | |
|           | A trained style runs   | |
|           | on the model it was    | |
|           | trained on. Pick No    | |
|           | style or Match an      | |
|           | image in the Style     | |
|           | chip to use another    | |
|           | model.                 | |
|           +------------------------+ |
```

Otherwise the Model menu shows each model's price for this document and these settings (`Free` for a zero price).

## 6. Library

Not in this build. Open from Library returns as a flow of the creation panel (SPEC 3.5, later flows); until then the Library stays in the web app and hosted Scenario MCP.

## 7. Composer

Pinned at the bottom (SPEC 3.7): the refs row (document references first, then this run's references with `x`, then `+`), the prompt with the action's placeholder or, for an action without a prompt, one line saying so, the chips (each shows its value), the button with the action and its price, and `[*]` for the action's advanced settings.

```
+--------------------------------------+
| [Set: Harbor] [th x] [th x] [ + ]    |
| Describe what goes inside the        |
| selection                            |
| [v No style] [v GPT Image 2.5 Flare] |
| [v 2 takes]                          |
| (    Replace inside . 3 CU     ) [*] |
+--------------------------------------+
```

Button labels:

| Label | When |
|---|---|
| `Fill in the prompt to see the price` | The action needs a prompt and the field is empty |
| `Replace inside . ...` | Price check in flight |
| `Replace inside . 3 CU` | Exact price from a current quote |
| `<Action> . Free` | An exact price of zero, never "0 CU" |
| `Make versions . 2 to 4 CU` | A range |
| `Upscale x2 . from 10 CU` | A `from` price; always confirmed |
| `Sending` | While the request is being sent |
| `Not available here` | No price; a longer reason shows under the button |

Advanced settings (`[*]`) for an edit:

```
|      +-----------------------------+ |
|      | ADVANCED . GPT Image 2.5    | |
|      | Flare                       | |
|      | Context margin [Auto][64 px]| |
|      |                 [None]      | |
|      | The model sees [All visible]| |
|      |                 [Current    | |
|      |                 layer]      | |
|      | Quality  [High][Medium][Low]| |
|      +-----------------------------+ |
```

**Quality** shows for models whose quality input offers High, Medium and Low (the GPT Image 2.5 models); Medium is the default and the price follows it.

## 8. Selection edit and the Takes card

F1 after the run landed. The takes are a group above Harbor, masked to the selection, take 1 visible. The Takes card shows in the middle part; a click on a tile shows that take in the document (one History state):

```
+--------------------------------------+
| +----+ Selection 928 x 640 on Harbor |
| |[sl]| Lands inside the selection,   |
| +----+ masked                        |
| ((Replace inside)) (Remove) ...      |
| ------------------------------------ |
| +----------------------------------+ |
| | a red-sailed fishing boat 2 takes| |
| | GPT Image 2.5 Flare . 3 CU       | |
| | +-------------+ +-------------+  | |
| | | [t1]   (o)1 | | [t2]      2 |  | |
| | |   Edges ok  | | May not line|  | |
| | +-------------+ +-------------+  | |
| | [ Keep take 1 ] [ Refine ]       | |
| | [ More like this ]               | |
| +----------------------------------+ |
| Recent on this document              |
| [r1] [r2] [r3]                       |
+--------------------------------------+
| (composer)                           |
+--------------------------------------+
```

`(o)` marks the take that shows; the badge is `Edges ok`, `May not line up` or, after Remove, `Part unchanged` (part of the selection came back as it was). **Keep take N** removes the other takes in one History state; their files stay in the Output Folder and in Jobs. **Refine** (tooltip "Keeps this take, then edits it") keeps the take that shows, loads the run's selection back from its mask and selects Replace inside with an empty prompt; the card's detail line reads "Starting from take 2 . lands inside the selection". **More like this** runs again with the shown take as a reference.

The group selected in the Layers panel, now or after a restart: the Takes context.

```
+--------------------------------------+
| +----+ 2 takes . a red-sailed fishing|
| |[t1]| boat                          |
| +-2--+ Showing take 1 . click a take |
|        to compare                    |
| ((Compare takes)) (More like this)   |
| (Refine) (Upscale kept take)         |
| ------------------------------------ |
| (the Takes card)                     |
+--------------------------------------+
| (i) Click a take above to show it in |
|     the document, then Keep it.      |
+--------------------------------------+
```

A run that did not land as takes (failed, waiting, or a result that opened as a new document) shows one line and **Done**:

```
| +----------------------------------+ |
| | a red-sailed fishing boat        | |
| | GPT Image 2.5 Flare . 3 CU       | |
| | [th] Failed: <Scenario's text>   | |
| |                        [ Done ]  | |
| +----------------------------------+ |
```

## 9. Details

From a Jobs row or the panel menu (not in this build):

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
|                 | Get help         | |
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

The person's click on a priced button is the approval. Above the confirm limit (Settings > Spending, default 100 CU, compared with M for a range), and for every `from` price, a confirm card opens in the composer, above the button, which waits for it:

```
+--------------------------------------+
| a lighthouse at dusk                 |
| [v 3:2 1536 x 1024] [v GPT Image 2.5 |
| Flare] [v 4 takes]                   |
| +----------------------------------+ |
| | This costs 150 CU, above your    | |
| | confirm limit of 100 CU.         | |
| |   [ Cancel ] [ Create image .    | |
| |                150 CU ]          | |
| +----------------------------------+ |
| (   Create image . 150 CU    )   [*] |
+--------------------------------------+
```

For a range the card reads "This costs N to M CU; M CU is above your confirm limit of 100 CU." When the model gives no refund on failure, the card adds "No refund if it fails."

For a `from` price, whatever the limit, the card reads "This costs from N CU. The charge can be higher; Scenario gives no upper bound for this model."

When the exact price after upload differs from the price on the button, the job waits for approval and the card reads:

```
| +----------------------------------+ |
| | Price changed after upload. Now  | |
| | 5 CU (was 2 CU). Nothing was     | |
| | spent.                           | |
| |     [ Cancel ] [ Approve . 5 CU ]| |
| +----------------------------------+ |
```

**Cancel** marks the job not sent ("Not sent: Declined."); nothing is charged.

An agent asks to spend (F5). The card sits above the composer only while a request exists; the header's agent icon shows who is connected:

```
+--------------------------------------+
| +----------------------------------+ |
| | * Claude wants to                | |
| | Replace inside the selection on  | |
| | Harbor, 2 takes                  | |
| | "a red-sailed fishing boat"      | |
| | GPT Image 2.5 Flare . 3 CU       | |
| |        [ Decline ] [ Approve ]   | |
| +----------------------------------+ |
| (composer)                           |
+--------------------------------------+
```

**Decline** tells the agent and spends nothing ("Declined. The agent was told, and nothing was spent."). Approved runs land in Takes like the person's own, marked with the agent's name. Agent spending runs through the agent link (M6); until then nothing raises the card.

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

With Agent spending set to **Ask each time** (the default), each request raises the card above; the card states the price kind ("N to M CU", "from N CU, no upper bound"). Each client has one pending card at a time, and a card expires after 10 minutes or when the client's session ends.

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

**Jobs** in the header opens the popover first (SPEC 3.11):

```
|            +-----------------------+ |
|            | JOBS ON THIS COMPUTER | |
|            | v Remove BG "knight"  | |
|            |   10:42 . 1 CU        | |
|            |   Image "harbor key"  | |
|            |   Unknown . 09:58 .   | |
|            |   2 CU                | |
|            | --------------------- | |
|            | Every file stays in   | |
|            | the output folder,    | |
|            | kept or not.          | |
|            |   All jobs            | |
|            |   Place, open or      | |
|            |   resolve a job       | |
|            +-----------------------+ |
```

A row or **All jobs** opens the Jobs view, also reachable from the panel menu. **On this computer** is the ledger:

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
|      Claude Code . 13:40             |
|      quoted N, charged N CU          |
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
|      [ Details ] [ Copy error ]      |
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

Each message names what happened and the next action. The full list is SPEC 3.13. Under every error, **Report a problem** opens the repository's issue form with nothing attached, and **Get help** opens Scenario's help center.

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
| This action can't read this          |
| document's color mode.               |
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

Opened from the panel menu `[=]`; Settings, Connect an AI Agent, Diagnostics and About each open it at their section. The agent section is worded for a person ("Connect an AI agent", "Pair a client"); how the link works (the local program, localhost, the port, the pairing token) is under a **Details** disclosure.

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
| terms . Get help . Report a problem  |
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
|     commands (batchPlay) on the      |
|     document in front: layers,       |
|     selections, masks, adjustments,  |
|     filters and transforms. Each     |
|     call is one History step.        |
|     Commands that save, close,       |
|     export or print, play Actions,   |
|     run scripts, use Adobe's         |
|     generative features or change    |
|     Photoshop's settings are always  |
|     refused. Turn on only for agents |
|     you trust.                       |
|     Needs the switch above. Turns    |
|     off when Photoshop quits.        |
|                                      |
| [ ] Agents read the active document  |
|     only                             |
|     Agents see only the document you |
|     are working on and the jobs made |
|     from it on this computer. Images |
|     already in your Scenario project,|
|     such as generations and Library  |
|     assets, stay visible to agents.  |
+--------------------------------------+
| Agent spending                       |
| (o) Ask each time                    |
| ( ) Allow without asking for         |
|     [ Claude Code, since 14:02  v ]  |
|     up to [  50 ] CU per call and    |
|     [ 300 ] CU in total, until its   |
|     session ends, Photoshop quits    |
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

Settings > Agents > Connect a client. The plugin cannot write client config files from its sandbox (SPEC 7.4), so each client gets the shortest path that works from the panel. Commands pin the exact helper version. Status comes from the clients the helper reports. On Windows the copy buttons give the PowerShell form of each command (SPEC 7.4).

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
| [ Copy command ]                     |
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
