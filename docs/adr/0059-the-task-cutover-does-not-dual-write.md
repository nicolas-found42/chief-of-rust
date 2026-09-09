# The Task cutover does not dual-write

The Tasks product is built in verified stages while incomplete surfaces remain inaccessible, then enabled through one idempotent migration and a complete cutover. Production never writes both canonical Tasks and the legacy Run-local Google receipt format: dual-writing would restore ambiguity about which record is true and make retries capable of creating duplicates. Historical Run files remain readable, while the legacy index-addressed review and bulk Google creation paths are removed after migration.
