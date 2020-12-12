import * as path from 'path';
import * as solparse from '@solidity-parser/parser';
import * as vscode from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { Contract } from './model/contract';
import { ContractCollection } from './model/contractsCollection';
import { Project } from './model/project';
import { initialiseProject } from './projectService';
import { LocationLink, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getAllNodes } from './util';

export class SolidityDefinitionProvider {
  private rootPath: string;
  private packageDefaultDependenciesDirectory: string;
  private packageDefaultDependenciesContractsDirectory: string;
  private project: Project;

  constructor(
    rootPath: string,
    packageDefaultDependenciesDirectory: string,
    packageDefaultDependenciesContractsDirectory: string,
  ) {
    this.rootPath = rootPath;
    this.packageDefaultDependenciesDirectory = packageDefaultDependenciesDirectory;
    this.packageDefaultDependenciesContractsDirectory = packageDefaultDependenciesContractsDirectory;

    if (this.rootPath !== 'undefined' && this.rootPath !== null) {
      this.project = initialiseProject(
        this.rootPath,
        this.packageDefaultDependenciesDirectory,
        this.packageDefaultDependenciesContractsDirectory,
      );
    }
  }

  private resolveClickedNode(offset: number, element: any, potentials: any[]): any[] {
    if (element instanceof Object) {
      Object.keys(element).forEach(it => {
        if (element.range && element.range[0] <= offset && offset <= element.range[1]) {
          potentials.push(element);
        }
        if (element[it] instanceof Array && element[it][0] instanceof Object) {
          for (const i of element[it]) {
            potentials = potentials.concat(this.resolveClickedNode(offset, i, []))
          }
        } else if (element[it] instanceof Object) {
          potentials = potentials.concat(this.resolveClickedNode(offset, element[it], []))
        }
      });
    }
    return Array.from(new Set(potentials));
  }

  

    private getDeclarationLocal(nameField: string, scope: any[]): any {
      for(const i of scope) {
        let declaration = getAllNodes(i, []).filter(n => (n.type.endsWith("Declaration") || n.type.endsWith("Definition")) && n.name === nameField)[0]
        if (declaration) {
          return declaration;
        }
      }
    }

    private getContractByName(contractName: string, contracts: ContractCollection): any {
      for (const c of contracts.contracts) {
        const result: any = solparse.parse(c.code, { range: true, loc: true });
        let declaration =  result.children.filter(c => c.type === "ContractDefinition" && c.name === contractName)[0]
        if (declaration) {
          return Object.assign(declaration, {contract: c})
        }
      }
    }


  private getDeclarationGlobal(nameField: string, scope: any[], contracts: ContractCollection): any {
    const result = this.getDeclarationLocal(nameField, scope);
    if (result) return result;

    for (const c of contracts.contracts) {
      const result: any = solparse.parse(c.code, { range: true, loc: true });
      const declaration = this.getDeclarationLocal(nameField, [result])
      if (declaration) {
        return Object.assign(declaration, {contract: c});
      }
    }
  }


  /**
   * Provide definition for cursor position in Solidity codebase. It calculate offset from cursor position and find the
   * most precise statement in solparse AST that surrounds the cursor. It then deduces the definition of the element based
   * on the statement type.
   *
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   * @returns {(Thenable<vscode.Location | vscode.Location[]>)}
   * @memberof SolidityDefinitionProvider
   */
  public async provideDefinition(
    document: TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location | vscode.Location[] | vscode.DefinitionLink[]> {
    const documentText = document.getText();
    const contractPath = URI.parse(document.uri).fsPath;
    const contracts = new ContractCollection();
    if (this.project !== undefined) {
      contracts.addContractAndResolveImports(
        contractPath,
        documentText,
        this.project,
      );
    }
    // this contract
    const contract = contracts.contracts[0];

    const offset = document.offsetAt(position);
    const result: any = solparse.parse(documentText, { range: true, loc: true });

    const clickedNodeTree = this.resolveClickedNode(offset, result, []).sort((a, b) => (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]))
    const element = clickedNodeTree[0];
    console.log(element);

    if (element !== undefined) {
      switch (element.type) {
        case 'ImportDirective':
          const link: LocationLink = LocationLink.create(
            URI.file(this.resolveImportPath(element.path, contract)).toString(),
            vscode.Range.create(0, 0, 0, 0),
            vscode.Range.create(0, 0, 0, 0),
            vscode.Range.create(element.loc.start.line - 1, element.loc.end.column - element.path.length - 2, element.loc.end.line - 1, element.loc.end.column),
          )
          return Promise.resolve(
            [link]
          );
        case 'UserDefinedTypeName':
          return this.getDeclarationForIdentifier(element.namePath, clickedNodeTree, contract, contracts);
        case 'ModifierInvocation':
        case 'Identifier':
          return this.getDeclarationForIdentifier(element.name, clickedNodeTree, contract, contracts);
        case 'MemberAccess':
          // todo: handle super
          const reservedExpressions = ['msg', 'tx', 'block']
          if (reservedExpressions.indexOf(element.expression.name) !== -1) return;
          let resolvedExpression = this.getDeclarationGlobal(element.expression.name, clickedNodeTree, contracts);
          if (resolvedExpression.typeName && resolvedExpression.typeName.type == 'UserDefinedTypeName') {
            resolvedExpression = this.getDeclarationGlobal(resolvedExpression.typeName.namePath, clickedNodeTree, contracts);
          }
          console.log(resolvedExpression);
          return this.getDeclarationForIdentifier(element.memberName, [resolvedExpression], resolvedExpression.contract ? resolvedExpression.contract: contract, contracts);
        case 'InheritanceSpecifier':
          let declaration = this.getContractByName(element.baseName.namePath, contracts);
          return Promise.resolve(
            vscode.Location.create(
              declaration.contract ? URI.file(declaration.contract.absolutePath).toString() : URI.file(contract.absolutePath).toString(),
              vscode.Range.create(declaration.loc.start.line - 1, declaration.loc.start.column, declaration.loc.end.line - 1, declaration.loc.end.column)
            )
          );
        default:
          break;
      }
    }
  }

  private getDeclarationForIdentifier(nameField: any, clickedNodeTree: any[], contract: Contract, contracts: ContractCollection) {
    let declaration = this.getDeclarationGlobal(nameField, clickedNodeTree, contracts);

    return Promise.resolve(
      vscode.Location.create(
        declaration.contract ? URI.file(declaration.contract.absolutePath).toString() : URI.file(contract.absolutePath).toString(),
        vscode.Range.create(declaration.loc.start.line - 1, declaration.loc.start.column, declaration.loc.end.line - 1, declaration.loc.end.column)
      )
    );
  }

  /**
   * Resolve import statement to absolute file path
   *
   * @private
   * @param {string} importPath import statement in *.sol contract
   * @param {Contract} contract the contract where the import statement belongs
   * @returns {string} the absolute path of the imported file
   * @memberof SolidityDefinitionProvider
   */
  private resolveImportPath(importPath: string, contract: Contract): string {
    if (contract.isImportLocal(importPath)) {
      return contract.formatContractPath(path.resolve(path.dirname(contract.absolutePath), importPath));
    } else if (this.project !== undefined) {
      const depPack = this.project.findPackage(importPath);
      if (depPack !== undefined) {
        return contract.formatContractPath(depPack.resolveImport(importPath));
      }
    }
    return importPath;
  }
}
