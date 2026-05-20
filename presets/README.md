# Local game presets

Drop GameDefinition JSON files in this directory and the server will seed
them into the local SQLite `arena_games` table on startup via
`GamesRepository.seedFromJsonFile`. This lets you test JSON games without
needing a Supabase connection.

Each file should follow the GameDefinition shape (see
`src/services/catalog-sync.ts` for the fields the engine reads). At a
minimum: `id`, `name`, `players`, `duration`, `scoring`.
