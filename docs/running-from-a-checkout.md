# Run it from a checkout

```console
$ code --extensionDevelopmentPath="$PWD" path/to/folder
```

Pressing `F5` does the same through `.vscode/launch.json`, which builds `dist/` first. That file
has two configurations, `Selvage (first window)` and `Selvage (second window)`, each with its own
`--user-data-dir` under `.tmp/`, because a session needs two windows that do not share state.
Launch the first, then start the second from the same window you launched the first from.
