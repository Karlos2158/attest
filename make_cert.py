# -*- coding: utf-8 -*-
"""Создаёт локальный корневой сертификат (CA) и TLS-сертификат для тренажёра.

Зачем: браузер на телефоне пускает к микрофону только по HTTPS.
Нужен один раз: python make_cert.py   (нужен пакет cryptography)

Результат в папке certs:
  ca.crt / ca.key        — самоподписанный корневой (его ставим на телефон как доверенный)
  server.crt / server.key — сертификат для 192.168.1.194, localhost, 127.0.0.1
"""
import datetime
import ipaddress
import socket
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ROOT = Path(__file__).parent
CERTS = ROOT / "certs"
DAYS_CA = 3650
DAYS_SRV = 825


def lan_ips() -> list:
    ips = {"127.0.0.1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    # адрес, через который виден интернет/шлюз — обычно и есть адрес в Wi-Fi сети
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith("169.254."))


def write(path: Path, data: bytes) -> None:
    path.write_bytes(data)
    print("  ", path.name, len(data), "байт")


def make_ca() -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "Attest Trainer Local CA"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "EGO Bottego"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=DAYS_CA))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_cert_sign=True, crl_sign=True,
                content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    write(CERTS / "ca.key", key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ))
    write(CERTS / "ca.crt", cert.public_bytes(serialization.Encoding.PEM))
    return cert, key


def make_server(ca_cert, ca_key) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ips = lan_ips()
    host = socket.gethostname()
    san = [x509.DNSName("localhost"), x509.DNSName(host)]
    san += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    now = datetime.datetime.now(datetime.timezone.utc)
    common = ips[0] if ips else "localhost"
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, common),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "EGO Bottego"),
        ]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=DAYS_SRV))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_encipherment=True,
                content_commitment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=False,
                crl_sign=False, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    write(CERTS / "server.key", key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ))
    write(CERTS / "server.crt", cert.public_bytes(serialization.Encoding.PEM))
    print("Сертификат выдан для:", ", ".join(ips), "и", host)


def main() -> None:
    CERTS.mkdir(exist_ok=True)
    if (CERTS / "server.crt").exists() and "--force" not in sys.argv:
        print("Сертификаты уже есть в", CERTS, "— пересоздать: python make_cert.py --force")
        return
    print("Делаю локальный CA…")
    ca_cert, ca_key = make_ca()
    print("Делаю сертификат сервера…")
    make_server(ca_cert, ca_key)
    print("Готово. ca.crt нужно один раз поставить на телефон (или просто принять предупреждение).")


if __name__ == "__main__":
    main()
