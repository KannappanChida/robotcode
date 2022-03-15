/* eslint-disable @typescript-eslint/restrict-template-expressions */
import * as net from "net";
import * as vscode from "vscode";
import {
  CloseHandlerResult,
  ErrorAction,
  CloseAction,
  ErrorHandlerResult,
  LanguageClient,
  LanguageClientOptions,
  Message,
  ServerOptions,
  TransportKind,
  ResponseError,
  InitializeError,
  RevealOutputChannelOn,
  State,
  Position,
  Range,
} from "vscode-languageclient/node";
import { sleep, Mutex } from "./utils";
import { CONFIG_SECTION } from "./config";
import { PythonManager } from "./pythonmanger";
import { getAvailablePort } from "./net_utils";

const LANGUAGE_SERVER_DEFAULT_TCP_PORT = 6610;
const LANGUAGE_SERVER_DEFAULT_HOST = "127.0.0.1";

export function toVsCodeRange(range: Range): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}

export interface RobotTestItem {
  type: string;
  id: string;
  uri?: string;
  children: RobotTestItem[] | undefined;
  label: string;
  longname: string;
  description?: string;
  range?: Range;
  error?: string;
  tags?: string[];
}

export interface EvaluatableExpression {
  range: Range;

  expression?: string;
}

export interface InlineValueText {
  type: "text";
  readonly range: Range;
  readonly text: string;
}

export interface InlineValueVariableLookup {
  type: "variable";
  readonly range: Range;
  readonly variableName?: string;
  readonly caseSensitiveLookup: boolean;
}

export interface InlineValueEvaluatableExpression {
  type: "expression";
  readonly range: Range;
  readonly expression?: string;
}

export type InlineValue = InlineValueText | InlineValueVariableLookup | InlineValueEvaluatableExpression;

export enum ClientState {
  Stopped,
  Starting,
  Running,
}

export interface ClientStateChangedEvent {
  uri: vscode.Uri;
  state: ClientState;
}

export class LanguageClientsManager {
  private clientsMutex = new Mutex();

  public readonly clients: Map<string, LanguageClient> = new Map();
  public readonly outputChannels: Map<string, vscode.OutputChannel> = new Map();

  private _disposables: vscode.Disposable;

  private readonly _onClientStateChangedEmitter = new vscode.EventEmitter<ClientStateChangedEvent>();

  public get onClientStateChanged(): vscode.Event<ClientStateChangedEvent> {
    return this._onClientStateChangedEmitter.event;
  }

  constructor(
    public readonly extensionContext: vscode.ExtensionContext,
    public readonly pythonManager: PythonManager,
    public readonly outputChannel: vscode.OutputChannel
  ) {
    this._disposables = vscode.Disposable.from(
      this.pythonManager.pythonExtension?.exports.settings.onDidChangeExecutionDetails(async (uri) =>
        this.refresh(uri)
      ) ?? {
        dispose() {
          //empty
        },
      },
      vscode.workspace.onDidChangeWorkspaceFolders(async (_event) => this.refresh()),
      vscode.workspace.onDidOpenTextDocument(async (document) => this.getLanguageClientForDocument(document))
    );
  }

  public async stopAllClients(): Promise<boolean> {
    const promises: Promise<void>[] = [];

    const clients = [...this.clients.values()];
    this.clients.clear();

    for (const client of clients) {
      promises.push(client.stop());
    }

    return Promise.all(promises).then(
      (r) => {
        return r.length > 0;
      },
      (reason) => {
        this.outputChannel.appendLine(`can't stop client ${reason}`);
        return true;
      }
    );
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

  private async getServerOptions(folder: vscode.WorkspaceFolder, mode: string): Promise<ServerOptions> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder);

    const pythonCommand = this.pythonManager.getPythonCommand(folder);

    if (!pythonCommand) {
      throw new Error("Can't find a valid python executable.");
    }

    const serverArgs = config.get<string[]>("languageServer.args", []);

    const args: string[] = [
      "-u",

      // "-m",
      // "debugpy",
      // "--listen",
      // "5678",
      // "--wait-for-client",

      this.pythonManager.pythonLanguageServerMain,
    ];

    const debug_args: string[] = ["--log"];

    const transport = { stdio: TransportKind.stdio, pipe: TransportKind.pipe, socket: TransportKind.socket }[mode];

    const getPort = async () => {
      return getAvailablePort(["127.0.0.1"]);
    };

    return {
      run: {
        command: pythonCommand,
        args: [...args, ...serverArgs],
        options: {
          cwd: folder.uri.fsPath,
        },

        transport:
          transport !== TransportKind.socket
            ? transport
            : { kind: TransportKind.socket, port: (await getPort()) ?? -1 },
      },
      debug: {
        command: pythonCommand,
        args: [...args, ...debug_args, ...serverArgs],
        options: {
          cwd: folder.uri.fsPath,
        },
        transport:
          transport !== TransportKind.socket
            ? transport
            : { kind: TransportKind.socket, port: (await getPort()) ?? -1 },
      },
    };
  }

  public async getLanguageClientForDocument(document: vscode.TextDocument): Promise<LanguageClient | undefined> {
    if (document.languageId !== "robotframework") return;

    return this.getLanguageClientForResource(document.uri);
  }

  public async getLanguageClientForResource(
    resource: string | vscode.Uri,
    create = true
  ): Promise<LanguageClient | undefined> {
    return this.clientsMutex.dispatch(async () => {
      const uri = resource instanceof vscode.Uri ? resource : vscode.Uri.parse(resource);
      let workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

      if (!workspaceFolder || !create) {
        if (vscode.workspace.workspaceFolders?.length === 1) {
          workspaceFolder = vscode.workspace.workspaceFolders[0];
        } else if (vscode.workspace.workspaceFolders?.length == 0) {
          workspaceFolder = undefined;
        } else {
          workspaceFolder = undefined;
        }
      }

      if (!workspaceFolder || !create) return undefined;

      let result = this.clients.get(workspaceFolder.uri.toString());

      if (result) return result;

      const config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);

      const mode = config.get<string>("languageServer.mode", "stdio");

      const serverOptions: ServerOptions =
        mode === "tcp" ? this.getServerOptionsTCP(workspaceFolder) : await this.getServerOptions(workspaceFolder, mode);

      const name = `RobotCode Language Server mode=${mode} for folder "${workspaceFolder.name}"`;

      const outputChannel = this.outputChannels.get(name) ?? vscode.window.createOutputChannel(name);
      this.outputChannels.set(name, outputChannel);

      let closeHandlerAction = CloseAction.DoNotRestart;

      const clientOptions: LanguageClientOptions = {
        documentSelector:
          vscode.workspace.workspaceFolders?.length === 1
            ? [{ scheme: "file", language: "robotframework" }]
            : [{ scheme: "file", language: "robotframework", pattern: `${workspaceFolder.uri.fsPath}/**/*` }],
        synchronize: {
          configurationSection: [CONFIG_SECTION],
        },
        initializationOptions: {
          storageUri: this.extensionContext?.storageUri?.toString(),
          globalStorageUri: this.extensionContext?.globalStorageUri?.toString(),
        },
        revealOutputChannelOn: RevealOutputChannelOn.Info,
        initializationFailedHandler: (error: ResponseError<InitializeError> | Error | undefined) => {
          if (error)
            void vscode.window // NOSONAR
              .showErrorMessage(error.message, { title: "Retry", id: "retry" })
              .then(async (item) => {
                if (item && item.id === "retry") {
                  await this.refresh();
                }
              });

          return false;
        },
        errorHandler: {
          error(_error: Error, _message: Message | undefined, _count: number | undefined): ErrorHandlerResult {
            return {
              action: ErrorAction.Continue,
            };
          },

          closed(): CloseHandlerResult {
            return {
              action: closeHandlerAction,
            };
          },
        },
        diagnosticCollectionName: "robotcode",
        workspaceFolder,
        outputChannel,
        markdown: {
          isTrusted: true,
          supportHtml: true,
        },
        progressOnInitialization: true,
      };

      this.outputChannel.appendLine(`create Language client: ${name}`);
      result = new LanguageClient(`$robotCode:${workspaceFolder.uri.toString()}`, name, serverOptions, clientOptions);

      this.outputChannel.appendLine(`trying to start Language client: ${name}`);
      result.start();

      result.onDidChangeState((e) => {
        if (e.newState == State.Running) {
          closeHandlerAction = CloseAction.Restart;
        } else if (e.newState == State.Stopped) {
          if (workspaceFolder && this.clients.get(workspaceFolder.uri.toString()) !== result)
            closeHandlerAction = CloseAction.DoNotRestart;
        }

        this._onClientStateChangedEmitter.fire({
          uri: uri,
          state:
            e.newState === State.Starting
              ? ClientState.Starting
              : e.newState === State.Stopped
              ? ClientState.Stopped
              : ClientState.Running,
        });
      });

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
            // do nothing
            this.outputChannel.appendLine(
              `client  ${result?.clientOptions.workspaceFolder?.uri ?? "unknown"} did not initialize correctly`
            );
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

  public async refresh(uri?: vscode.Uri): Promise<void> {
    await this.clientsMutex.dispatch(async () => {
      if (uri) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

        if (!workspaceFolder) return;

        const client = this.clients.get(workspaceFolder.uri.toString());
        this.clients.delete(workspaceFolder.uri.toString());

        if (client) {
          await client.stop();
          await sleep(500);
        }
      } else {
        if (await this.stopAllClients()) {
          await sleep(500);
        }
      }
    });

    const folders = new Set<vscode.WorkspaceFolder>();

    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === "robotframework") {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (workspaceFolder) {
          folders.add(workspaceFolder);
        } else if (vscode.workspace.workspaceFolders?.length === 1) {
          folders.add(vscode.workspace.workspaceFolders[0]);
        }
      }
    }

    for (const folder of folders) {
      try {
        await this.getLanguageClientForResource(folder.uri.toString()).catch((_) => undefined);
      } catch {
        // do noting
      }
    }
  }

  public async getTestsFromWorkspace(
    workspaceFolder: vscode.WorkspaceFolder,
    paths?: string[],
    suites?: string[],
    token?: vscode.CancellationToken
  ): Promise<RobotTestItem[] | undefined> {
    const robotFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, "**/*.robot"),
      undefined,
      1,
      token
    );

    if (robotFiles.length === 0) {
      return undefined;
    }

    const client = await this.getLanguageClientForResource(workspaceFolder.uri);

    if (!client) return;

    return (
      (token
        ? await client.sendRequest<RobotTestItem[]>(
            "robot/discovering/getTestsFromWorkspace",
            {
              workspaceFolder: workspaceFolder.uri.toString(),
              paths: paths,
              suites,
            },
            token
          )
        : await client.sendRequest<RobotTestItem[]>("robot/discovering/getTestsFromWorkspace", {
            workspaceFolder: workspaceFolder.uri.toString(),
            paths: paths,
          })) ?? undefined
    );
  }

  public async getTestsFromDocument(
    document: vscode.TextDocument,
    base_name?: string,
    token?: vscode.CancellationToken
  ): Promise<RobotTestItem[] | undefined> {
    const client = await this.getLanguageClientForResource(document.uri);

    if (!client) return;

    return (
      (token
        ? await client.sendRequest<RobotTestItem[]>(
            "robot/discovering/getTestsFromDocument",
            {
              textDocument: { uri: document.uri.toString() },
              base_name: base_name,
            },
            token
          )
        : await client.sendRequest<RobotTestItem[]>("robot/discovering/getTestsFromDocument", {
            textDocument: { uri: document.uri.toString() },
            base_name: base_name,
          })) ?? undefined
    );
  }

  public async getEvaluatableExpression(
    document: vscode.TextDocument,
    position: Position,
    token?: vscode.CancellationToken
  ): Promise<EvaluatableExpression | undefined> {
    const client = await this.getLanguageClientForResource(document.uri);

    if (!client) return;

    return (
      (token
        ? await client.sendRequest<EvaluatableExpression | undefined>(
            "robot/debugging/getEvaluatableExpression",
            {
              textDocument: { uri: document.uri.toString() },
              position,
            },
            token
          )
        : await client.sendRequest<EvaluatableExpression | undefined>("robot/debugging/getEvaluatableExpression", {
            textDocument: { uri: document.uri.toString() },
            position,
          })) ?? undefined
    );
  }

  public async getInlineValues(
    document: vscode.TextDocument,
    viewPort: vscode.Range,
    context: vscode.InlineValueContext,
    token?: vscode.CancellationToken
  ): Promise<InlineValue[]> {
    const client = await this.getLanguageClientForResource(document.uri);

    if (!client) return [];

    return (
      (token
        ? await client.sendRequest<InlineValue[]>(
            "robot/debugging/getInlineValues",
            {
              textDocument: { uri: document.uri.toString() },
              viewPort: { start: viewPort.start, end: viewPort.end },
              context: {
                frameId: context.frameId,
                stoppedLocation: { start: context.stoppedLocation.start, end: context.stoppedLocation.end },
              },
            },
            token
          )
        : await client.sendRequest<InlineValue[]>("robot/debugging/getInlineValues", {
            textDocument: { uri: document.uri.toString() },
            viewPort: { start: viewPort.start, end: viewPort.end },
            context: {
              frameId: context.frameId,
              stoppedLocation: { start: context.stoppedLocation.start, end: context.stoppedLocation.end },
            },
          })) ?? []
    );
  }
}
