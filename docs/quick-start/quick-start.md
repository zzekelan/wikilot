# Wikilot quick start

Help the user install Wikilot and get started with their first Workspace.
Follow this guide interactively, one step at a time, instead of summarizing it.
Start by asking where they want to install Wikilot. Reuse answers the user has
already provided.

1. Ask which directory should contain the Wikilot installation. Explain that
   this is the app's directory; they will choose a folder for their knowledge
   work separately. Keep an existing installation and local changes intact.

2. Check that Git, npm, and Node.js 22.18 or newer are available; help install
   missing prerequisites using the user's existing package or version manager.
   The current native folder chooser requires macOS. On another OS, explain
   that Workspace onboarding is limited and ask whether they want to proceed.

3. Clone the public `dev` branch into the chosen directory, then run setup:

   ```bash
   git clone --branch dev --single-branch https://github.com/zzekelan/wikilot.git <installation-directory>
   cd <installation-directory>
   npm run setup
   ```

   Replace the placeholder with the chosen path, quoted for the user's shell.
   Setup installs dependencies and starts the app in the default browser.
   It does not register a global command. Run it in a terminal the user can
   keep open.

4. Read the terminal's local URL and verify that Wikilot opens. If the browser
   does not open automatically, open that URL. If port 5173 is occupied, use
   `npm run wikilot -- --port 5174` from the installation directory. With no browser access, ask the user to confirm that
   the interface appeared before continuing.

5. Guide the user through the following steps in order. Explain each when they
   reach it and continue after it is complete.

   | Step | Guide the user |
   | --- | --- |
   | Open a Workspace | Use the folder chooser to open the folder where they want to work with their files. |
   | Connect a Provider | Open Settings and configure a Provider. Have the user enter their API key directly in the app or complete the available authentication flow. |
   | Start a Session | Create a Session and choose a Model. Help send a short greeting and confirm that the Model responds. |
   | Initialize the Workspace | Introduce `/init`, which starts a conversation to agree on the Workspace's purpose and organization. Help the user invoke it if they want to set up their Workspace now. |

6. Tell the user where Wikilot is installed and how to use it next time:
   run `npm run wikilot` from the installation directory; keep its terminal open; press Ctrl+C in
   that terminal to stop it. Closing the browser tab does not stop the service.
   Keep the installation directory and its dependencies. Report which setup
   steps succeeded and any remaining user action.
