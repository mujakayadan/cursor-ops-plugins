---
name: digitalocean-dns-change
description: Make DNS changes on DigitalOcean-managed domains safely - inspect existing records, avoid conflicts, add records, and delete with typed confirmation. Use when the user asks to add, change, point, or remove DNS records on DigitalOcean.
---

# DNS changes on DigitalOcean

1. **Inspect.** Run `digitalocean_domain_records` and check for conflicts:
   - A CNAME can't coexist with other records of the same name.
   - Check for duplicate A/AAAA records and the apex (`@`) rules.
2. **Plan.** Show the exact record (type, name, data, TTL). For cutovers, lower the TTL to 300 first and wait out the old TTL before switching.
3. **Add.** Use `digitalocean_domain_record_create` (write tier).
4. **Change.** There is no in-place edit tool by design: create the new record, verify it, then delete the old one.
5. **Delete** (privileged). Run `digitalocean_domain_record_delete` with `confirm: "<domain>/<record id>"`, but only after the user confirms that exact record id.
6. **Verify.** Re-list the records. Optionally check public resolution with `Resolve-DnsName <name> -Server 1.1.1.1` (PowerShell) or `dig @1.1.1.1 <name>`.
