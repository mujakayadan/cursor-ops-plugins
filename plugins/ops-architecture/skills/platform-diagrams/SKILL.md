---
name: platform-diagrams
description: Draw cloud and platform architecture diagrams with the official AWS, Azure, Google Cloud, Kubernetes, DigitalOcean, on-prem and SaaS icons, from a JSON spec committed next to the rendered image. Use for deployment, infrastructure, network or platform views where each cloud service should appear with its own icon; boxes-and-arrows diagrams stay in Mermaid.
---

# Platform diagrams

A platform diagram is a JSON spec in `docs/architecture/<name>.diagram.json`, rendered next to it as `<name>.png` (or `.svg`) by the `ops-architecture` tools with the Python `diagrams` library and Graphviz. The spec is data, not code, so previews are safe to run automatically. Commit the spec and the image together; `architecture_check` fails when the image is missing or older than its spec.

## Workflow

1. **Check the toolchain:** `architecture_status`. When it isn't `ready`, give the user its `install` command (`ops setup ops-architecture`).
2. **Find the icons:** `architecture_icons` with the `provider` and a `query` (`queue`, `lambda`, `kubernetes`, `gateway`). Use the exact `category.Class` it returns; never guess a class name. The first call downloads the library (about 35 MB) once.
3. **Write the spec** in `docs/architecture/<name>.diagram.json`.
4. **Preview:** `architecture_preview` with `file`. It reports every spec problem at once, or returns a PNG. Read the PNG and fix crossings, cramped clusters and unreadable labels, then preview again.
5. **Render:** `architecture_render` with `file` (approval) writes the image next to the spec. Pass `overwrite: true` when re-rendering. Embed it in Markdown with a path relative to the document, such as `![Production deployment](docs/architecture/production.png)`.

## Spec

```json
{
  "title": "Orders platform – production (us-east-1)",
  "direction": "LR",
  "nodes": [
    { "id": "users", "icon": "onprem.client.Users", "label": "Customers" },
    { "id": "cdn", "icon": "aws.network.CloudFront", "label": "CloudFront" },
    { "id": "alb", "icon": "aws.network.ElbApplicationLoadBalancer", "label": "ALB" },
    { "id": "api", "icon": "aws.compute.Fargate", "label": "Orders API" },
    { "id": "db", "icon": "aws.database.Aurora", "label": "Aurora PostgreSQL" }
  ],
  "clusters": [
    {
      "label": "VPC 10.0.0.0/16",
      "clusters": [
        { "label": "Public subnets", "nodes": ["alb"] },
        { "label": "Private subnets", "nodes": ["api", "db"] }
      ]
    }
  ],
  "edges": [
    { "from": "users", "to": "cdn", "label": "HTTPS" },
    { "from": "cdn", "to": "alb" },
    { "from": "alb", "to": "api" },
    { "from": "api", "to": "db", "label": "SQL/TLS" }
  ]
}
```

| Field | Rules |
|---|---|
| `title` | Required. Name the environment and region. |
| `direction` | `LR` (default), `TB`, `RL`, `BT`; clusters may set their own. |
| `nodes` | 1 to 80. `id` is lowercase (`api_gateway`); `icon` is `provider.category.Class`; `label` up to 80 characters, `\n` for a line break. |
| `clusters` | Nested up to 5 deep. Each node sits in at most one cluster; nodes in none are drawn at the top level. |
| `edges` | Up to 200. `style`: `solid`, `dashed` (asynchronous), `dotted` (optional or management), `bold` (critical path); `direction`: `forward` (default), `back`, `both`, `none`; `color`: `#rrggbb`. |

Icon providers: `aws`, `azure`, `gcp`, `k8s`, `digitalocean`, `oci`, `ibm`, `alibabacloud`, `openstack`, `outscale`, `elastic`, `firebase`, `onprem` (also clients, databases, CI and observability tools), `saas` (identity, CDN, chat, payments), `programming` (languages and frameworks), `generic`, `gis`, `c4`. Platforms without an icon set, such as Vercel, use the closest `saas` or `generic` icon with a precise label.

## Conventions per platform

Draw the real boundaries a developer has to configure, outermost first:

- **AWS:** account (with its purpose) → region → VPC with its CIDR → availability zones when the design is multi-AZ → public, private and isolated subnets. Edge services (Route 53, CloudFront, WAF, Shield) sit outside the VPC; regional managed services (S3, DynamoDB, SQS, SNS, EventBridge, Secrets Manager, KMS, CloudWatch) sit in the region outside the VPC and connect through VPC endpoints where the design uses them.
- **Azure:** tenant → subscription → resource group → VNet → subnets; Front Door and DNS at the edge, Entra ID for identity, Key Vault, Monitor and Log Analytics alongside.
- **Google Cloud:** organization or folder → project → VPC → region → subnets; Cloud Load Balancing and Cloud Armor at the edge.
- **Kubernetes:** cluster → namespace → workloads (Deployment, StatefulSet, Job) with their Service and Ingress; draw the cloud's managed cluster (EKS, AKS, GKE) as the outer cluster.
- **DigitalOcean:** project → region → VPC; App Platform, Droplets, Managed Databases and Spaces inside.

Also show identity (IdP), secrets, observability (metrics, logs, traces, alerting) and the CI/CD path that deploys into each environment. Draw one diagram per environment shape that differs, such as production with multi-AZ and a single-AZ preview.

## Layout tips

- 10 to 30 nodes per diagram. Split a big estate into an overview plus one diagram per account, region or bounded context.
- `LR` for request flow from users to data; `TB` for layered estates.
- Declare nodes in reading order; Graphviz follows it.
- Label edges with protocol or purpose (`HTTPS`, `gRPC`, `events`, `SQL/TLS`), not with step numbers; step order belongs in sequence diagrams.
- Group replicas by labelling one node `Orders API ×3` rather than drawing three.
