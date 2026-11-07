# Dolibarr, a real application to test

[Dolibarr](https://www.dolibarr.org) is an open source ERP/CRM. It is here to try IziTest on a real
business application: quotes, orders, invoices, credit notes, deposits, VAT, discounts, due dates,
PDF documents. The use cases and what to measure are in [cas-d-usage.md](cas-d-usage.md) (in
French).

## Start it

Needs Docker.

```bash
./setup.sh              # once: writes .env, this machine's secrets (never committed)
docker compose up -d    # then http://localhost:8090 (the first start takes about a minute)
```

- **No login page**: every visitor is the administrator (Alice Adminson). Nobody types a
  password, neither a person nor a test.
- **In French** for everyone, even a headless Chrome that asks for English.
- **Dolibarr's demo data**: 30 third parties, 22 products and services, 40 quotes, 39 orders,
  66 invoices (credit notes and deposits among them).
- **The company**: Atelier Demo, in France (VAT at 20 %, 10 %, 5.5 % and 2.1 %).

[scripts/before-starting.d/10-izitest.sh](scripts/before-starting.d/10-izitest.sh) sets this at
every start.

In IziTest, create a project for it with `http://localhost:8090` as its address.

## Stop it, start over

```bash
docker compose down       # stops it; the data stays
docker compose down -v    # stops it and deletes the data: the next start loads the demo again
```

## Upgrade it: the maintenance case

It starts on 23.0.4, the version before the latest. To move to 24:

1. In `.env`, replace `DOLIBARR_VERSION=23.0.4` with `DOLIBARR_VERSION=24.0.2`.
2. Run `docker compose up -d`.

The image migrates the database by itself and keeps the data; it first saves a backup in the
documents volume. Same tests, an application that changed: what broke, what IziTest repaired by
itself. To go back to 23: `docker compose down -v`, put the version back, `docker compose up -d`.

## Limit

Everyone being the administrator, the rights of other users cannot be tested. To test them, set
`DOLI_AUTH: dolibarr` back in [docker-compose.yml](docker-compose.yml), and decide how the tests
log in.
