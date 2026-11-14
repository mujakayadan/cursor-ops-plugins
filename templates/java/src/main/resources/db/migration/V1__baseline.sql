-- Baseline migration. Add new files as V2__describe_change.sql; never edit an applied migration.
create table if not exists app_metadata (
    key   text primary key,
    value text not null
);
