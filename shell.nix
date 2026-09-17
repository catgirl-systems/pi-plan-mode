{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  packages = [
    pkgs.nodejs_22 # matches package.json engines >=22; CI runs tests on 22, releases on 24
    pkgs.git
  ];
}
