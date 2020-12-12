'use strict';

export function formatPath(contractPath: string) {
        return contractPath.replace(/\\/g, '/');
}


export function getAllNodes(element: any, existing: any[]): any[] {
        if (element instanceof Object) {
                Object.keys(element).forEach(it => {
                        if (element.type) {
                                existing.push(element);
                        }
                        if (element[it] instanceof Array && element[it][0] instanceof Object) {
                                for (const i of element[it]) {
                                        existing = existing.concat(this.getAllNodes(i, []))
                                }
                        } else if (element[it] instanceof Object) {
                                existing = existing.concat(this.getAllNodes(element[it], []))
                        }
                });
        }
        return Array.from(new Set(existing));
}