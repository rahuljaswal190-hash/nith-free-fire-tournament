#!/usr/bin/env python3
"""Generate a PBKDF2-SHA256 admin password verifier without saving the password."""
from getpass import getpass

from server import create_password_hash


def main():
    first = getpass("New admin passphrase (at least 16 characters): ")
    second = getpass("Repeat passphrase: ")
    if first != second:
        raise SystemExit("Passphrases did not match; no hash was generated.")
    try:
        encoded = create_password_hash(first)
    except ValueError as error:
        raise SystemExit(str(error))
    print("\nCopy this verifier directly into Render > your service > Environment Variables.")
    print("Do not put the plaintext passphrase in source files, chat, or a commit.\n")
    print(f"TOURNAMENT_ADMIN_PASSWORD_HASH={encoded}")


if __name__ == "__main__":
    main()
