# Network setup

The Navionics app learns the plugin's address from the discovery packet, then
connects on port **22**. Choose one of these setups:

| Setup | Plugin bind IP | Host configuration |
| --- | --- | --- |
| Host network | A second LAN address, e.g. `192.168.1.250` | Redirect port 22 to port 2222 |
| Bridge container | `0.0.0.0` | Publish container port 22 |

Set the plugin's **IP address to bind SSH server to** to the value in the
second column.

## Host network

Use a free address on the same LAN as the phone, outside the router's DHCP
pool. Do not use the Signal K host's primary address, because that would
conflict with the host's SSH server.

### 1. Add the second address

**NetworkManager** (Fedora, Ubuntu Desktop, Debian Desktop):

```sh
nmcli -t -f NAME,DEVICE connection show --active
sudo nmcli connection modify <connection> +ipv4.addresses 192.168.1.250/24
sudo nmcli connection up <connection>
```

**netplan** (Ubuntu Server) — add `addresses` to the existing LAN interface:

```yaml
# /etc/netplan/*.yaml
network:
  version: 2
  ethernets:
    enp0s3:
      dhcp4: true
      addresses:
        - 192.168.1.250/24
```

```sh
sudo netplan try
sudo netplan apply
```

**ifupdown** (Debian) — add to the existing interface stanza:

```text
# /etc/network/interfaces
auto enp0s3
iface enp0s3 inet dhcp
    post-up ip addr add 192.168.1.250/24 dev enp0s3 || true
    pre-down ip addr del 192.168.1.250/24 dev enp0s3 || true
```

```sh
sudo ifup enp0s3
```

### 2. Redirect port 22 to 2222

**firewalld** (Fedora):

```sh
sudo firewall-cmd --permanent --direct --add-rule ipv4 nat PREROUTING 0 \
  -d 192.168.1.250 -p tcp --dport 22 \
  -j DNAT --to-destination 192.168.1.250:2222
sudo firewall-cmd --reload
```

**nftables** (Ubuntu/Debian):

```sh
sudo apt install nftables
sudo mkdir -p /etc/nftables.d

sudo tee /etc/nftables.d/navionics.nft >/dev/null <<'NFT'
table ip navionics_nat {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    ip daddr 192.168.1.250 tcp dport 22 dnat to 192.168.1.250:2222
  }
}
NFT

sudo tee /etc/systemd/system/navionics-nat.service >/dev/null <<'UNIT'
[Unit]
Description=Navionics port redirect
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table ip navionics_nat
ExecStart=/usr/sbin/nft -f /etc/nftables.d/navionics.nft
ExecStop=/usr/sbin/nft delete table ip navionics_nat

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now navionics-nat.service
```

This does not flush existing firewall rules, so Podman and Docker rules stay
intact.

## Podman container

Set the plugin bind IP to `0.0.0.0` and publish port 22 in the quadlet. When
bound this way, the plugin advertises the container's own LAN address in the
discovery packets:

```ini
PublishPort=22:22
Sysctl=net.ipv4.ip_unprivileged_port_start=0
```

The sysctl lets the Signal K `node` user bind port 22 inside the container.
A root or privileged container can bind it without the sysctl, but running
Signal K as root is not recommended.

Requirements:

- Host port 22 must be free. If host sshd uses it, use host-network mode.
- Do not publish `2222:22`; the app expects port 22.
- Verify that the phone sees the host LAN address as the discovery source. If
  it sees the container's private address instead, use host-network mode.

## Verify

```sh
ip -4 addr show dev <interface>
ss -ltn | grep -E ':22 |:2222'
nc -vz 192.168.1.250 22
```

In host-network mode, the plugin normally falls back from port 22 to 2222
because the host SSH server owns port 22. The `nc` check should still succeed
through the redirect.

## Changing the address

If `192.168.1.250` is already used, choose another free address and replace it
in the address, redirect rule, and plugin **IP address to bind SSH server to**
setting.
