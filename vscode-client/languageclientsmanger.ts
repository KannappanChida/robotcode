/* eslint-disable @typescript-eslint/restrict-template-expressions */
import * as net from "net";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";
import { sleep, Mutex } from "./utils";
import { CONFIG_SECTION } from "./config";
import { PythonManager } from "./pythonmanger";

const LANGUAGE_SERVER_DEFAULT_TCP_PORT = 6610;
const LANGUAGE_SERVER_DEFAULT_HOST = "127.0.0.1";

export interface RobotPosition {
  line: number;
  character: number;
}

export interface RobotRange {
  start: RobotPosition;
  end: RobotPosition;
}

export interface RobotTestItem {
  type: string;
  id: string;
  uri?: string;
  children: RobotTestItem[] | undefined;
  label: string;
  description?: string;
  range?: RobotRange;
  error?: string;
  tags?: string[];
}

export class LanguageClientsManager {
  private clientsMutex = new Mutex();

  public readonly clients: Map<string, LanguageClient> = new Map();

  private _disposables: vscode.Disposable;

  constructor(
    public readonly extensionContext: vscode.ExtensionContext,
    public readonly pythonManager: PythonManager,
    public readonly outputChannel: vscode.OutputChannel
  ) {
    this._disposables = vscode.Disposable.from(
      this.pythonManager.pythonExtension?.exports.settings.onDidChangeExecutionDetails(async (_event) =>
        this.refresh()
      ) ?? {
        dispose() {
          //empty
        },
      },
      vscode.workspace.onDidChangeWorkspaceFolders(async (_event) => this.refresh()),
      vscode.workspace.onDidOpenTextDocument(async (document) => this.getLanguageClientForDocument(document))
    );
  }

  public async stopAllClients(): Promise<void> {
    await this.clientsMutex.dispatch(async () => {
      const promises: Promise<void>[] = [];

      for (const client of this.clients.values()) {
        promises.push(client.stop());
      }
      this.clients.clear();

      await Promise.all(promises);
    });
  }

  dispose(): void {
    this.stopAllClients().then(
      (_) => undefined,
      (_) => undefined
    );

    this._disposables.dispose();
  }

  // eslint-disable-next-line class-methods-use-this
  private getServerOptionsTCP(folder: vscode.WorkspaceFolder) {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder);
    let port = config.get<number>("languageServer.tcpPort", LANGUAGE_SERVER_DEFAULT_TCP_PORT);
    if (port === 0) {
      port = LANGUAGE_SERVER_DEFAULT_TCP_PORT;
    }
    const serverOptions: ServerOptions = function () {
      return new Promise((resolve, reject) => {
        const client = new net.Socket();
        client.on("error", (err) => {
          reject(err);
        });
        const host = LANGUAGE_SERVER_DEFAULT_HOST;
        client.connect(port, host, () => {
          resolve({
            reader: client,
            writer: client,
          });
        });
      });
    };
    return serverOptions;
  }

  private getServerOptionsStdIo(folder: vscode.WorkspaceFolder) {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder);

    const pythonCommand = this.pythonManager.getPythonCommand(folder);

    if (!pythonCommand) {
      throw new Error("Can't find a valid python executable.");
    }

    const serverArgs = config.get<Array<string>>("languageServer.args", []);

    const args: Array<string> = ["-u", this.pythonManager.pythonLanguageServerMain, "--mode", "stdio"];

    const serverOptions: ServerOptions = {
      command: pythonCommand,
      args: args.concat(serverArgs),
      options: {
        cwd: folder.uri.fsPath,
        // detached: true
      },
    };
    return serverOptions;
  }

  public async getLanguageClientForDocument(document: vscode.TextDocument): Promise<LanguageClient | undefined> {
    if (document.languageId !== "robotframework") return;

    return this.getLanguageClientForResource(document.uri);
  }

  public async getLanguageClientForResource(resource: string | vscode.Uri): Promise<LanguageClient | undefined> {
    return this.clientsMutex.dispatch(async () => {
      const uri = resource instanceof vscode.Uri ? resource : vscode.Uri.parse(resource);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

      if (!workspaceFolder) {
        return undefined;
      }

      let result = this.clients.get(workspaceFolder.uri.toString());

      if (result) return result;

      const config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);

      const mode = config.get<string>("languageServer.mode", "stdio");

      const serverOptions: ServerOptions =
        mode === "tcp" ? this.getServerOptionsTCP(workspaceFolder) : this.getServerOptionsStdIo(workspaceFolder);
      const name = `RobotCode Language Server mode=${mode} for folder "${workspaceFolder.name}"`;

      const outputChannel = mode === "stdio" ? vscode.window.createOutputChannel(name) : undefined;

      const clientOptions: LanguageClientOptions = {
        documentSelector: [
          { scheme: "file", language: "robotframework", pattern: `${workspaceFolder.uri.fsPath}/**/*` },
        ],
        synchronize: {
          configurationSection: [CONFIG_SECTION],
        },
        initializationOptions: {
          storageUri: this.extensionContext?.storageUri?.toString(),
          globalStorageUri: this.extensionContext?.globalStorageUri?.toString(),
        },
        diagnosticCollectionName: "robotcode",
        workspaceFolder,
        outputChannel,
        markdown: {
          isTrusted: true,
        },
        progressOnInitialization: true,
      };

      this.outputChannel.appendLine(`create Language client: ${name}`);
      result = new LanguageClient(name, serverOptions, clientOptions);

      this.outputChannel.appendLine(`trying to start Language client: ${name}`);
      result.start();

      result = await result.onReady().then(
        async (_) => {
          this.outputChannel.appendLine(`client  ${result?.clientOptions.workspaceFolder?.uri ?? "unknown"} ready.`);
          let counter = 0;
          try {
            while (!result?.initializeResult && counter < 1000) {
              await sleep(10);
              counter++;
            }
          } catch {
            return undefined;
          }
          return result;
        },
        (reason) => {
          this.outputChannel.appendLine(
            `client  ${result?.clientOptions.workspaceFolder?.uri ?? "unknown"} error: ${reason}`
          );
          return undefined;
        }
      );

      if (result) this.clients.set(workspaceFolder.uri.toString(), result);

      return result;
    });
  }

  public async refresh(_uri?: vscode.Uri | undefined): Promise<void> {
    await this.clientsMutex.dispatch(async () => {
      for (const client of this.clients.values()) {
        await client.stop().catch();
      }
      this.clients.clear();
    });

    for (const document of vscode.workspace.textDocuments) {
      try {
        await this.getLanguageClientForDocument(document).catch();
      } catch {
        // do nothing
      }
    }
  }

  public async getTestsFromWorkspace(
    workspaceFolder: vscode.WorkspaceFolder,
    paths?: Array<string>
  ): Promise<RobotTestItem[] | undefined> {
    const client = await this.getLanguageClientForResource(workspaceFolder.uri);

    if (!client) return;

    return (
      (await client.sendRequest<RobotTestItem[]>("robot/discovering/getTestsFromWorkspace", {
        workspaceFolder: workspaceFolder.uri.toString(),
        paths: paths ?? ["."],
      })) ?? undefined
    );
  }

  public async getTestsFromDocument(document: vscode.TextDocument, id?: string): Promise<RobotTestItem[] | undefined> {
    const client = await this.getLanguageClientForResource(document.uri);

    if (!client) return;

    return (
      (await client.sendRequest<RobotTestItem[]>("robot/discovering/getTestsFromDocument", {
        textDocument: { uri: document.uri.toString() },
        id: id,
      })) ?? undefined
    );
  }
}
