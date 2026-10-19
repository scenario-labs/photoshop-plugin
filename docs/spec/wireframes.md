# Wireframes (spec v1)

Status: draft for review, 2026-10-19. Companion to [SPEC.md](SPEC.md), section 3.

- Every frame is drawn at the default docked width, 320 px, as 40 columns of 8 px. The minimum width is 280 px (35 columns); below 320 px the lane tabs drop to icons with tooltips.
- `[ Label ]` is a button, `[v]` a dropdown, `( )` and `(o)` radio buttons, `[ ]` and `[x]` checkboxes, `(Chip)` a filter chip, `[th]` a thumbnail, `>` a disclosure row.
- All Creative Unit figures are placeholders (`N CU`, `M CU`). Model names are placeholders: the plugin shows names and descriptions from the Scenario catalog.
- UXP has no CSS transitions, so state changes are immediate; every progress bar carries text.


## 1. First run and sign-in

Shown when no key is saved. **Create an API key** opens the key page on app.scenario.com in the browser; Photoshop asks for consent on that click. Pasting `key:secret` or two lines into the first field fills both fields.

```
+--------------------------------------+
| [S] Scenario                         |
+--------------------------------------+
| Connect your Scenario account        |
| to generate in Photoshop.            |
|                                      |
| 1. Create an API key on Scenario.    |
|    [ Create an API key ]             |
| 2. Paste the key and its secret.     |
|                                      |
| API key                              |
| [ Paste key, or key:secret        ]  |
| API secret                           |
| [ ************************  Show  ]  |
|                                      |
| [ Save and test                   ]  |
|                                      |
| Keys stay in Photoshop's secure      |
| storage on this computer.            |
| How sign-in works  |  Privacy        |
+--------------------------------------+
```

States of the same screen after **Save and test**:

```
+--------------------------------------+
| [ Save and test ]   Testing...       |
+--------------------------------------+
| x Scenario did not accept this key   |
|   and secret.                        |
|   [ Enter key again ] [ Create key ] |
+--------------------------------------+
| x No connection to Scenario.         |
|   Check your network.  [ Retry ]     |
+--------------------------------------+
| Connected to Scenario                |
| Project: Fall campaign               |
| Key ....7KQ2                         |
+--------------------------------------+
```

Then the ready card, shown once, above the Image lane:

```
+--------------------------------------+
| Ready.                               |
| 1  Pick a lane: Image, Edit, Enhance.|
| 2  Select an area, or nothing for    |
|    the whole canvas.                 |
| 3  Describe it. The price is on the  |
|    Generate button.                  |
|                           [ Got it ] |
+--------------------------------------+
```

## 2. Main view with lanes

Header, lane tabs, lane body (scrolls), results tray, prompt bar (fixed). The dot before **Jobs** is the agent connection: hollow when no agent is connected, filled when one is. The Image lane with a selection active:

```
+--------------------------------------+
| [S] Fall campaign     * Jobs 2   [=] |
+--------------------------------------+
| [Image] Edit  Enhance Trained Library|
+--------------------------------------+
| Target  Selection 928 x 928     [v]  |
|         lands masked to selection    |
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
| Latest: 4 takes, placed              |
| [t1*] [t2] [t3] [t4]                 |
| Seam ok                              |
| [ Keep this take ]  [ Details ]      |
+--------------------------------------+
| Describe the image...                |
|                                      |
| Takes [4 v]   Size [3:2 v]           |
| [ Generate N CU                   ]  |
+--------------------------------------+
```

**+ Add** on references opens a menu: Selection, Current layer, All visible, From Library, File... The Enhance lane puts its tool selector where the model card sits:

```
+--------------------------------------+
| [S] Fall campaign     * Jobs 2   [=] |
+--------------------------------------+
| Image  Edit [Enhance] Trained Library|
+--------------------------------------+
| Tool  (Upscale) (Expand) (Remove BG) |
|                                      |
| Source  All visible 3000 x 2000 [v]  |
| Model   Model name       [ Change ]  |
| Factor  [2x v]   Output 6000 x 4000  |
| Lands   (o) New document             |
|         ( ) Layer in this document   |
| > Advanced (3 settings)              |
+--------------------------------------+
| [ Generate N CU                   ]  |
+--------------------------------------+
```

## 3. Model picker

A full panel view (text fields render above overlays in UXP, so the picker cannot float over the form). Type tabs follow the lanes; chips come from the catalog plus three plugin chips.

```
+--------------------------------------+
| < Models                             |
| [ Search models                   ]  |
| [Image] Edit  Enhance  Trained       |
| (Favorites) (Mask input) (References)|
| (Category A) (Category B) (more v)   |
+--------------------------------------+
| [th] * Model name                    |
|        Two-line description from     |
|        the catalog.                  |
|        Mask input . 4 refs . 4096 px |
+--------------------------------------+
| [th]   Model name                    |
|        Two-line description from     |
|        the catalog.                  |
|        4 refs . 2048 px              |
+--------------------------------------+
| [th]   Trained model name   Trained  |
|        Your team's model, runs on    |
|        its base model.               |
+--------------------------------------+
|              [ Load more ]           |
+--------------------------------------+
```

Empty result:

```
+--------------------------------------+
| < Models                             |
| [ Search: neon logo                ] |
| (Mask input x)                       |
+--------------------------------------+
| No models in this lane match these   |
| filters.                             |
|                [ Clear filters ]     |
+--------------------------------------+
```

## 4. Prompt bar

Fixed at the bottom of every generating lane. Enter generates when the price is current; Shift+Enter adds a line; Up and Down in an empty field recall recent prompts. The button states:

```
+--------------------------------------+
| A coastal town at dusk, warm window  |
| lights, wet cobblestones             |
| Takes [2 v]   Size [3:2 v]           |
+--------------------------------------+
| [ Generate N CU                   ]  |
|   exact price, quote valid 120 s     |
+--------------------------------------+
| [ Generate from N CU              ]  |
|   charge can be higher: per take     |
+--------------------------------------+
| [ Checking price...               ]  |
+--------------------------------------+
| [ Generate (price after upload)   ]  |
|   this model prices the uploaded     |
|   image; first click uploads it      |
+--------------------------------------+
| [ Confirm N CU                    ]  |
|   selection uploaded; price exact    |
+--------------------------------------+
| [ Price unavailable               ]  |
|   Prompt is required by this model.  |
+--------------------------------------+
```

## 5. Selection-aware edit

The Edit lane with a selection. The source chip follows the selection (coalesced at 200 ms). The capture is recorded when Generate is clicked, so changing the selection afterwards does not change the job.

```
+--------------------------------------+
| [S] Fall campaign     * Jobs 2   [=] |
+--------------------------------------+
| Image [Edit] Enhance Trained Library |
+--------------------------------------+
| Source  Selection 928 x 928     [v]  |
| Sample  All visible             [v]  |
| Margin  auto (464 px)   Feather 2 px |
|                                      |
| Model   Model name       [ Change ]  |
|         Mask input                   |
| > Advanced (5 settings)              |
+--------------------------------------+
| Replace the sky with dusk clouds     |
|                                      |
| Takes [2 v]                          |
| [ Generate N CU                   ]  |
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

Results landed as a group with take 1 visible. Clicking a thumbnail shows that take. Badges come from the checks in SPEC section 3.6:

```
+--------------------------------------+
| Latest: 2 takes, placed              |
| [t1*] [t2]                           |
| t1  Seam ok                          |
| t2  Edge tone differs                |
| [ Keep this take ]  [ Details ]      |
+--------------------------------------+
| Placed as "Scenario edit dusk-sky    |
| (2 takes)" above Sky. Ctrl+Z undoes  |
| it in one step.                      |
+--------------------------------------+
```

Special cases:

```
+--------------------------------------+
| ! Quick Mask is on.                  |
|   [ Use Quick Mask as selection ]    |
+--------------------------------------+
| ! The canvas changed since this edit |
|   started. The masked placement is   |
|   no longer exact.                   |
|   [ Place unmasked ] [ Open as doc ] |
+--------------------------------------+
| ! Unchanged inside: the model may    |
|   have read the mask inverted.       |
|   [ Details ]                        |
+--------------------------------------+
| ! Pixels outside the selection       |
|   changed.               [ Undo ]    |
+--------------------------------------+
```

## 6. Price before spend

The person's click on a priced button is the approval. Three extra screens exist. Above the confirm limit (Settings > Spending, default 100 CU), a modal dialog:

```
+--------------------------------------+
| Confirm spend                        |
+--------------------------------------+
| This generation costs N CU, above    |
| your confirm limit of 100 CU.        |
|                                      |
| Model name . 4 takes . 4096 x 4096   |
|                                      |
| [ Cancel ]           [ Spend N CU ]  |
+--------------------------------------+
```

When the exact price after upload differs from the price shown on the button:

```
+--------------------------------------+
| Price changed after upload.          |
| Now N CU (was M CU). Nothing was     |
| spent.                               |
| [ Cancel ]        [ Generate N CU ]  |
+--------------------------------------+
```

When an agent asks to spend and Agent spending is **Ask each time** (the default). The card sits at the top of the panel and in Jobs:

```
+--------------------------------------+
| ! Claude Code asks to spend N CU     |
+--------------------------------------+
| Edit . Model name . 2 takes          |
| "Replace the sky with dusk clouds"   |
| Inputs  [ctx] [mask]                 |
| Target  poster.psd, above Sky        |
|                                      |
| Client name as reported by the       |
| client.                              |
| [ Decline ]       [ Approve N CU ]   |
+--------------------------------------+
```

## 7. Jobs view

Opened from **Jobs** in the header. Two tabs. **On this computer** is the ledger:

```
+--------------------------------------+
| < Jobs                               |
| [On this computer]  On Scenario      |
| (All) (Needs attention 1) (Agents)   |
+--------------------------------------+
| [th] Edit "dusk-sky"     generating  |
|      You . quoted N CU . 14:02       |
|      [====      ] 1 of 2  [ Cancel ] |
+--------------------------------------+
| [th] Image "forest-plate"    placed  |
|      Claude Code . N / N CU . 13:40  |
|      [ Select layer ]  [ Details ]   |
+--------------------------------------+
| [!]  Upscale "poster"       Unknown  |
|      You . quoted N CU . 13:12       |
|      [ Resolve ]                     |
+--------------------------------------+
| [th] Expand "banner"  downloading    |
|      2 of 4      [ Stop download ]   |
+--------------------------------------+
| [x]  Image "logo"            Failed  |
|      Charged N CU, no refund         |
|      [ Copy error ] [ Edit, retry ]  |
+--------------------------------------+
```

Resolving an Unknown job. Only the person can do this; agents get `UnknownNeedsPerson`:

```
+--------------------------------------+
| < Resolve unknown job                |
+--------------------------------------+
| The request may or may not have      |
| reached Scenario. Nothing is         |
| retried until you decide.            |
|                                      |
| Sent 13:12 . Model name . N CU       |
| Jobs on Scenario, same model:        |
| (o) 13:12:41  same inputs     [th]   |
| ( ) 13:31:05  other inputs    [th]   |
|                                      |
| [ Link this job ] [ Mark not sent ]  |
| [ Check again ]                      |
+--------------------------------------+
```

**On Scenario** lists the project's recent jobs, including ones made elsewhere. Nothing here spends:

```
+--------------------------------------+
| < Jobs                               |
| On this computer  [On Scenario]      |
| Fall campaign . last 30 days         |
+--------------------------------------+
| [th] Model name . 12:01 . done       |
|      [ Place ] [ Open as document ]  |
|      [ Use as reference ]            |
|      [ Add to this computer ]        |
+--------------------------------------+
| [th] Model name . 11:40 . done       |
|      [ Place ] [ Open as document ]  |
|      [ Use as reference ]            |
+--------------------------------------+
|              [ Load more ]           |
+--------------------------------------+
```

## 8. Error and empty states

Each message names what happened and the next action. Full list in SPEC section 3.9.

```
+--------------------------------------+
| Offline. Price checks paused; jobs   |
| resume when the connection returns.  |
+--------------------------------------+
| Scenario refused this request:       |
| <Scenario's message>  [ Copy error ] |
+--------------------------------------+
| Not enough Creative Units for this   |
| job.                [ Open plans ]   |
+--------------------------------------+
| Not sent: Scenario asked to wait     |
| 30 s.                [ Try again ]   |
+--------------------------------------+
| This lane reads RGB, Gray or Lab     |
| documents. This one is CMYK.         |
|                 [ Make RGB copy ]    |
+--------------------------------------+
| Photoshop is busy. Placing when it   |
| is free.                             |
+--------------------------------------+
| Download stopped after 3 attempts.   |
|                 [ Resume download ]  |
+--------------------------------------+
| Scenario blocked this request        |
| (content policy).    [ Details ]     |
+--------------------------------------+
```

Empty states:

```
+--------------------------------------+
| Jobs you start here or from an agent |
| appear here.                         |
+--------------------------------------+
| Your team has no trained models      |
| yet. Train one on app.scenario.com.  |
|                 [ Open Scenario ]    |
+--------------------------------------+
| No assets in this project yet.       |
+--------------------------------------+
| Models could not load.  [ Retry ]    |
+--------------------------------------+
```

Loading: skeleton rows, never a bare spinner:

```
+--------------------------------------+
| Loading models...                    |
| [th] ======================          |
|      ===============                 |
| [th] ======================          |
|      ===============                 |
+--------------------------------------+
```

## 9. The "agents may modify the document" switch

Settings > Agents. Both switches are off by default; the second needs the first. The person's choice persists across restarts.

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
| [ ] Agents may run Photoshop scripts |
|     Needs the switch above. Scripts  |
|     can change anything except       |
|     saving, closing and exporting.   |
+--------------------------------------+
| Agent spending                       |
| (o) Ask me each time                 |
| ( ) Allow without asking, up to      |
|     [ 100 ] CU per call, until       |
|     Photoshop quits                  |
+--------------------------------------+
| [ Connect a client ]                 |
| [ Activity log ]                     |
| [ Reset pairing token ]              |
+--------------------------------------+
```

With the switch off, an agent's apply becomes a proposal card:

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

With the switch on, the header says so, and each agent change shows a toast:

```
+--------------------------------------+
| [S] Fall campaign     * Jobs 2   [=] |
| ! Agents can edit            [ Off ] |
+--------------------------------------+
| Claude Code placed "Scenario image   |
| forest-plate 0f1e2d".      [ Undo ]  |
+--------------------------------------+
```

## 10. Connect a client

Settings > Agents > Connect a client. The plugin cannot write client config files from its sandbox (SPEC section 7.4), so each client gets the shortest path that works from the panel. Status comes from the clients the helper reports.

```
+--------------------------------------+
| < Connect a client                   |
| Agents reach Photoshop through the   |
| scenario-photoshop helper, which     |
| runs on this computer.               |
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
| With Node: [ Copy setup command ]    |
| Skills:    [ Copy skills command ]   |
+--------------------------------------+
| Commands need Node 20 or later; the  |
| Claude Desktop extension does not.   |
| Pairing token ....9F3A  [ Reset ]    |
+--------------------------------------+
```

After **Copy command**:

```
+--------------------------------------+
| Copied. Paste it in a terminal,      |
| then restart Claude Code. The row    |
| turns to Connected on the first      |
| call.                                |
+--------------------------------------+
```
