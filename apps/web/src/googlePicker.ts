/**
 * Google Picker for Drive folder selection. The only place this app loads
 * remote code (ADR-0013 exception to ADR-0001). Fetched on click, not on page
 * load, and remembered for the session so a second pick does not refetch.
 */

/**
 * The slice of `google.picker` this app touches. Google ships no types for the
 * Picker, so these are declared here — and the builder methods are declared to
 * return the builder, which is what lets the chain below stay typed instead of
 * falling back to `any`.
 */
interface DocsView {
  setMimeTypes: (mimeTypes: string) => DocsView;
  setSelectFolderEnabled: (enabled: boolean) => DocsView;
}

interface PickedData {
  action: string;
  docs?: { id: string; name: string }[];
}

interface PickerBuilder {
  setOAuthToken: (token: string) => PickerBuilder;
  addView: (view: DocsView) => PickerBuilder;
  setCallback: (callback: (data: PickedData) => void) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
}

interface PickerNamespace {
  DocsView: new (viewId: unknown) => DocsView;
  ViewId: { FOLDERS: unknown };
  PickerBuilder: new () => PickerBuilder;
  Action: { PICKED: string; CANCEL: string };
}

let gapiReady = false;
let gapiPromise: Promise<void> | null = null;

function loadGapi(): Promise<void> {
  if (gapiReady) return Promise.resolve();
  if (gapiPromise) return gapiPromise;

  const { promise, resolve, reject } = Promise.withResolvers<void>();

  const script = document.createElement("script");
  script.src = "https://apis.google.com/js/api.js";
  script.async = true;
  script.onload = () => {
    const gapi = (
      window as unknown as {
        gapi?: {
          load: (name: string, opts: { callback: () => void; onerror?: () => void }) => void;
        };
      }
    ).gapi;
    if (!gapi) {
      reject(new Error("Google API loader did not initialise"));
      return;
    }
    gapi.load("picker", {
      callback: () => {
        gapiReady = true;
        resolve();
      },
      onerror: () => reject(new Error("Failed to load Google Picker")),
    });
  };
  script.onerror = () =>
    reject(
      new Error("Failed to reach Google's picker script — check your connection and try again."),
    );
  document.head.appendChild(script);

  gapiPromise = promise;
  promise.catch(() => {
    gapiPromise = null;
  });

  return promise;
}

/**
 * Open the Drive folder picker. Returns the chosen folder's id and name, or
 * null if the user cancelled. Rejects if the Picker script cannot be reached.
 *
 * No developer key and no appId: an API key authorises public-data views while
 * this picker is private-data access authorised by the OAuth token; setAppId is
 * for the drive.file scope while this app holds drive.
 */
export async function pickDriveFolder(
  oauthToken: string,
): Promise<{ id: string; name: string } | null> {
  await loadGapi();

  const { promise, resolve, reject } = Promise.withResolvers<{ id: string; name: string } | null>();

  try {
    const g = window as unknown as { google?: { picker?: PickerNamespace } };

    const pickerNs = g.google?.picker;
    if (!pickerNs) {
      reject(new Error("Google Picker not available after load"));
      return promise;
    }

    const view = new pickerNs.DocsView(pickerNs.ViewId.FOLDERS)
      .setMimeTypes("application/vnd.google-apps.folder")
      .setSelectFolderEnabled(true);

    const picker = new pickerNs.PickerBuilder()
      .setOAuthToken(oauthToken)
      .addView(view)
      .setCallback((data) => {
        const doc = data.docs?.[0];
        if (data.action === pickerNs.Action.PICKED && doc) {
          resolve({ id: doc.id, name: doc.name });
        } else if (data.action === pickerNs.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();

    picker.setVisible(true);
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)));
  }

  return promise;
}
